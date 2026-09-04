import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncate } from "@pi-kanban/shared";
import type { TodoSnapshotMessage } from "@pi-kanban/shared";
import { loadConfig } from "./config.js";
import { Transport } from "./transport.js";
import { runGate, type GateDeps } from "./gate.js";

/**
 * pi-kanban extension: streams session lifecycle to the pi-kanban cloud
 * dashboard and gates risky tool calls with local-first / cloud-fallback
 * approval. Runtime deps are bundled; pi package is type-only.
 */
export default function (pi: ExtensionAPI): void {
	const config = loadConfig();
	if (!config.server.agentToken) {
		// No token = never connectable = the plugin stays fully inert (the gate
		// bypasses too; see gate.ts). One line so an empty dashboard is diagnosable.
		console.error("[pi-kanban] no agent token configured (PI_KANBAN_TOKEN or ~/.pi/agent/pi-kanban.json)");
	}
	const transport = new Transport(config.server.url, config.server.agentToken);
	transport.connect();

	let sessionId: string | null = null;
	let messagePosition = 0;
	let currentTurn: number | null = null;
	let lastPrompt = "";
	let lastTodoHash = "";
	const toolStartTimes = new Map<string, number>();

	const gate: GateDeps = {
		gate: config.gate,
		transport,
		getSessionId: () => sessionId,
		getTurnPosition: () => (currentTurn ? currentTurn + 1 : undefined),
	};

	// --- session lifecycle -----------------------------------------------------

	pi.on("session_start", async (event, ctx) => {
		const id = ctx.sessionManager.getSessionId();
		if (!id) return; // ephemeral session (--no-session): nothing to track
		sessionId = id;
		messagePosition = 0;
		currentTurn = null;
		lastTodoHash = "";
		const [gitRemote, gitBranch] = await gitInfo(ctx.cwd);
		transport.send({
			type: "session_start",
			sessionId: id,
			cwd: ctx.cwd,
			gitRemote,
			gitBranch,
			reason: event.reason,
			startedAt: Date.now(),
		});
	});

	pi.on("session_shutdown", async (event) => {
		if (!sessionId) return;
		transport.send({
			type: "session_end",
			sessionId,
			reason: event.reason,
			endedAt: Date.now(),
		});
	});

	// --- turns -------------------------------------------------------------------

	pi.on("before_agent_start", async (event) => {
		lastPrompt = event.prompt;
	});

	pi.on("turn_start", async (event) => {
		if (!sessionId) return;
		currentTurn = event.turnIndex;
		transport.send({
			type: "turn_start",
			sessionId,
			position: event.turnIndex + 1,
			prompt: lastPrompt,
			startedAt: Date.now(),
		});
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!sessionId) return;
		transport.send({
			type: "turn_end",
			sessionId,
			position: (currentTurn ?? 0) + 1,
			endedAt: Date.now(),
		});
		await reportTodoSnapshot(ctx);
		currentTurn = null;
	});

	// --- message stream ------------------------------------------------------------

	pi.on("message_end", async (event, ctx) => {
		if (!sessionId) return;
		const message = event.message as {
			role?: string;
			content?: unknown;
			usage?: Record<string, unknown>;
		};
		messagePosition++;
		transport.send({
			type: "message",
			sessionId,
			turnPosition: currentTurn != null ? currentTurn + 1 : undefined,
			position: messagePosition,
			role: (message.role as "user" | "assistant" | "toolResult") ?? "custom",
			excerpt: excerpt(extractText(message.content)),
			usage: message.usage,
			costUsd: extractCost(message.usage),
			modelId: modelId(ctx),
			timestamp: Date.now(),
		});
	});

	// --- tool stream ------------------------------------------------------------------

	pi.on("tool_execution_start", async (event) => {
		if (!sessionId) return;
		toolStartTimes.set(event.toolCallId, Date.now());
		transport.send({
			type: "tool_call",
			sessionId,
			turnPosition: currentTurn != null ? currentTurn + 1 : undefined,
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			input: config.report.reportToolInputs ? event.args : undefined,
			startedAt: Date.now(),
		});
	});

	pi.on("tool_execution_end", async (event) => {
		if (!sessionId) return;
		const startedAt = toolStartTimes.get(event.toolCallId);
		toolStartTimes.delete(event.toolCallId);
		transport.send({
			type: "tool_result",
			sessionId,
			toolCallId: event.toolCallId,
			resultExcerpt: excerpt(extractText(event.result)),
			isError: Boolean(event.isError),
			endedAt: Date.now(),
			durationMs: startedAt ? Date.now() - startedAt : undefined,
		});
	});

	// --- approval gate ------------------------------------------------------------------

	pi.on("tool_call", async (event, ctx) => {
		return runGate(gate, event, ctx);
	});

	// --- heartbeat ------------------------------------------------------------------------

	const heartbeat = setInterval(() => {
		// Offline: skip entirely — heartbeats are only meaningful live, and
		// queueing them would evict real session events from the outbox.
		if (!transport.connected) return;
		transport.send({
			type: "heartbeat",
			sessionIds: sessionId ? [sessionId] : [],
			timestamp: Date.now(),
		});
	}, 30_000);
	heartbeat.unref?.();

	// --- helpers ------------------------------------------------------------------------------

	function excerpt(text: string): string | undefined {
		const trimmed = text.trim();
		if (!trimmed) return undefined;
		return truncate(trimmed, config.report.excerptChars);
	}

	async function reportTodoSnapshot(ctx: { sessionManager: { getEntries(): unknown[] } }): Promise<void> {
		if (!sessionId) return;
		try {
			const entries = ctx.sessionManager.getEntries() as Array<{
				type?: string;
				data?: { tasks?: Array<Record<string, unknown>> };
			}>;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				const tasks = entry?.type === "custom" ? entry.data?.tasks : undefined;
				if (!Array.isArray(tasks)) continue;
				const visible = tasks.filter(
					(t) => t && typeof t === "object" && t.status !== "deleted",
				);
				const snapshot: TodoSnapshotMessage = {
					type: "todo_snapshot",
					sessionId,
					todos: visible.map((t, index) => ({
						position: index,
						content: String(t.subject ?? ""),
						state: String(t.status ?? "pending"),
					})),
					timestamp: Date.now(),
				};
				const hash = JSON.stringify(snapshot.todos);
				if (hash !== lastTodoHash) {
					lastTodoHash = hash;
					transport.send(snapshot);
				}
				return;
			}
		} catch {
			// entry shape drift across pi versions — snapshots are best-effort
		}
	}
}

// --- tolerant field extraction -----------------------------------------------------------

function extractText(content: unknown): string {
	if (content == null) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				if (typeof block === "string") return block;
				if (block && typeof block === "object") {
					const text = (block as { text?: unknown }).text;
					if (typeof text === "string") return text;
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	try {
		return JSON.stringify(content);
	} catch {
		return "";
	}
}

function extractCost(usage: unknown): number | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const cost = (usage as { cost?: { total?: unknown } }).cost;
	if (cost && typeof cost === "object") {
		const total = (cost as { total?: unknown }).total;
		if (typeof total === "number" && Number.isFinite(total)) return total;
	}
	return undefined;
}

function modelId(ctx: { model?: { provider?: string; id?: string } }): string | undefined {
	const model = ctx.model;
	if (!model?.id) return undefined;
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

function gitInfo(cwd: string): Promise<[string | undefined, string | undefined]> {
	const run = (args: string[]): Promise<string | undefined> =>
		new Promise((resolve) => {
			execFile(
				"git",
				args,
				{ cwd, timeout: 1500 },
				(error, stdout) => resolve(error ? undefined : stdout.trim() || undefined),
			);
		});
	return Promise.all([
		run(["remote", "get-url", "origin"]),
		run(["rev-parse", "--abbrev-ref", "HEAD"]),
	]);
}
