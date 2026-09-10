import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { truncate } from "@pi-kanban/shared";
import type { MemoryDigestMessage, TodoSnapshotMessage } from "@pi-kanban/shared";
import { agentDir, agentToken, loadConfig } from "./config.js";
import { collectProjectSnapshot, gitIdentity, SnapshotThrottle } from "./project-snapshot.js";
import { cacheStats, loadCachedDigest, MEMORY_PROMPT_BUDGET_BYTES, projectKey, renderMemoryPrompt, saveDigest } from "./memory-cache.js";
import { formatStatus, type KanbanStatusSnapshot } from "./status.js";
import { Transport } from "./transport.js";
import { registerNotify, type Notify } from "./notify.js";
import { TurnState } from "./turn-state.js";
import { runGate, type GateDeps } from "./gate.js";

export { runGate };

/**
 * pi-kanban extension: streams session lifecycle to the pi-kanban cloud
 * dashboard and gates risky tool calls with local-first / cloud-fallback
 * approval. Runtime deps are bundled; pi package is type-only.
 */
export default function (pi: ExtensionAPI): void {
	const notify = registerNotify(pi);
	// Factory-time warnings are flushed on session_start: entries appended
	// during extension load can land before the TUI transcript is watching.
	const startupWarnings: Array<{ message: string; detail?: unknown }> = [];
	const warn: Notify = (message, detail) => startupWarnings.push({ message, detail });
	const config = loadConfig(warn);
	const token = agentToken();
	if (!token) {
		warn("no agent token configured — set the PI_KANBAN_TOKEN environment variable (e.g. in ~/.zshrc)");
	}
	const transport = new Transport(config.server.url, token, notify);

	let sessionId: string | null = null;
	const snapshotThrottle = new SnapshotThrottle();
	let messagePosition = 0;
	const turns = new TurnState();
	let lastPrompt = "";
	let lastTodoHash = "";
	let turnStartedAt = 0;
	let turnTtftMs: number | undefined;
	const toolStartTimes = new Map<string, number>();

	const gate: GateDeps = {
		gate: config.gate,
		transport,
		getSessionId: () => sessionId,
		getTurnPosition: () => turns.current,
	};

	// --- project memory digest (inspection → runtime loop) --------------------

	let activeProjectId: number | null = null;
	let activeKey = "";
	let activeDigest: MemoryDigestMessage | null = null;
	let activePromptBlock: string | undefined;
	let totalTurns = 0;
	let injectedTurns = 0;

	function applyDigest(digest: MemoryDigestMessage): void {
		activeProjectId = digest.projectId;
		activeDigest = digest;
		activePromptBlock = renderMemoryPrompt(digest, MEMORY_PROMPT_BUDGET_BYTES);
		saveDigest(agentDir(), activeKey, digest);
	}

	transport.onDigest((digest) => {
		// A fetch reply echoes our sessionId; a post-inspection push carries none
		// and only counts for the project this session already fetched.
		if (digest.sessionId != null ? digest.sessionId !== sessionId : digest.projectId !== activeProjectId) return;
		applyDigest(digest);
	});

	// --- /kanban-status: metrics snapshot, display-only transcript entry -------

	const STATUS_ENTRY_TYPE = "pi-kanban-status";
	pi.registerEntryRenderer(STATUS_ENTRY_TYPE, (entry, _options, theme) => {
		const text = (entry.data as { text?: string }).text ?? "";
		return new Text(theme.fg("dim", text));
	});
	pi.registerCommand("kanban-status", {
		description: "Show pi-kanban connection, memory digest and injection metrics",
		handler: async (_args, ctx) => {
			const snapshot: KanbanStatusSnapshot = {
				serverUrl: config.server.url,
				connected: transport.connected,
				queued: transport.queued,
				sessionId,
				totalTurns,
				injectedTurns,
				digest: activeDigest,
				promptBlockBytes: activePromptBlock ? Buffer.byteLength(activePromptBlock) : 0,
				promptBudgetBytes: MEMORY_PROMPT_BUDGET_BYTES,
				cacheEntries: cacheStats(agentDir()),
				now: Date.now(),
			};
			try {
				pi.appendEntry(STATUS_ENTRY_TYPE, { text: formatStatus(snapshot) });
			} catch {
				// Pre-session or non-interactive modes have no transcript to append to.
				ctx.ui.notify(formatStatus(snapshot), "info");
			}
		},
	});

	let heartbeat: ReturnType<typeof setInterval> | null = null;
	const startHeartbeat = () => {
		if (heartbeat) return;
		heartbeat = setInterval(() => {
			transport.heartbeat(sessionId ? [sessionId] : []);
		}, 30_000);
		heartbeat.unref();
	};

	// --- session lifecycle -----------------------------------------------------

	pi.on("session_start", async (event, ctx) => {
		const id = ctx.sessionManager.getSessionId();
		if (!id) return;
		for (const { message, detail } of startupWarnings.splice(0)) notify(message, detail);
		sessionId = id;
		transport.connect();
		startHeartbeat();
		messagePosition = 0;
		turns.reset();
		lastTodoHash = "";
		const identity = await gitIdentity(ctx.cwd);
		// Cached digest injects immediately (offline included); the fetch below
		// refreshes it once the server answers. activeKey scopes cache reads/writes.
		activeKey = projectKey(identity.gitRemote, ctx.cwd);
		activeProjectId = null;
		totalTurns = 0;
		injectedTurns = 0;
		const cachedDigest = loadCachedDigest(agentDir(), activeKey);
		if (cachedDigest) applyDigest(cachedDigest);
		else {
			activeDigest = null;
			activePromptBlock = undefined;
		}
		transport.send({
			type: "session_start",
			sessionId: id,
			cwd: ctx.cwd,
			gitRemote: identity.gitRemote,
			gitBranch: identity.gitBranch,
			title: pi.getSessionName() ?? null,
			reason: event.reason,
			startedAt: Date.now(),
		});
		transport.send({ type: "memory_fetch", sessionId: id });
		snapshotThrottle.reset();
		await refreshProjectSnapshot(ctx.cwd, identity, true);
	});

	pi.on("session_info_changed", (event) => {
		if (!sessionId) return;
		transport.send({ type: "session_title", sessionId, title: event.name ?? null });
	});

	pi.on("session_shutdown", (event) => {
		if (sessionId) {
			transport.send({
				type: "session_end",
				sessionId,
				reason: event.reason,
				endedAt: Date.now(),
			});
		}
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
		transport.close();
	});

	// --- turns -------------------------------------------------------------------

	pi.on("before_agent_start", async (event) => {
		lastPrompt = event.prompt;
		turnStartedAt = Date.now();
		turnTtftMs = undefined;
		if (!sessionId) return;
		const position = turns.start();
		transport.send({
			type: "turn_start",
			sessionId,
			position,
			prompt: lastPrompt,
			startedAt: Date.now(),
		});
		totalTurns++;
		// Stable per digest revision, so the provider prompt cache only invalidates
		// when an inspection actually changed the memories.
		if (activePromptBlock) {
			injectedTurns++;
			return { systemPrompt: `${event.systemPrompt}\n\n${activePromptBlock}` };
		}
		return undefined;
	});

	pi.on("agent_end", async (_event, ctx) => {
		const position = turns.finish();
		if (!sessionId || position == null) return;
		transport.send({
			type: "turn_end",
			sessionId,
			position,
			endedAt: Date.now(),
			ttftMs: turnTtftMs,
		});
		await reportTodoSnapshot(ctx);
		await refreshProjectSnapshot(ctx.cwd);
	});

	// TTFT: prompt submitted (before_agent_start) → first assistant message
	// starts streaming. Only the first assistant message of a turn counts.
	pi.on("message_start", async (event) => {
		if (turnTtftMs != null || !turnStartedAt) return;
		const message = event.message as { role?: string };
		if (message.role === "assistant") turnTtftMs = Date.now() - turnStartedAt;
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
			turnPosition: turns.current,
			position: messagePosition,
			role: (message.role as "user" | "assistant" | "toolResult") ?? "custom",
			excerpt: excerpt(extractText(message.content)),
			usage: message.usage,
			costUsd: extractCost(message.usage),
			modelId: modelId(ctx),
			contextWindow: contextWindow(ctx),
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
			turnPosition: turns.current,
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

	// --- helpers ------------------------------------------------------------------------------

	function excerpt(text: string): string | undefined {
		const trimmed = text.trim();
		if (!trimmed) return undefined;
		return truncate(trimmed, config.report.excerptChars);
	}

	async function refreshProjectSnapshot(
		cwd: string,
		identity?: { gitRemote?: string; gitBranch?: string },
		force = false,
	): Promise<void> {
		if (!sessionId) return;
		const now = Date.now();
		if (!force && !snapshotThrottle.isDue(now)) return;
		try {
			const snapshot = await collectProjectSnapshot({
				sessionId,
				cwd,
				...(identity ?? (await gitIdentity(cwd))),
			});
			const changed = snapshotThrottle.observe(snapshot.hash, now);
			if (changed || force) transport.send(snapshot);
		} catch (error) {
			snapshotThrottle.markRefreshed(now);
			notify("project snapshot failed", error);
		}
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
			notify("todo snapshot unavailable");
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

function contextWindow(ctx: { model?: { contextWindow?: unknown } }): number | undefined {
	const window = ctx.model?.contextWindow;
	return typeof window === "number" && Number.isFinite(window) && window > 0 ? window : undefined;
}
