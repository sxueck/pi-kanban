import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncate } from "@pi-kanban/shared";
import type { MemoryDigestMessage, SearchScope, TodoSnapshotMessage } from "@pi-kanban/shared";
import { agentDir, agentToken, loadConfig } from "./config.js";
import { collectProjectSnapshot, gitIdentity, SnapshotThrottle } from "./project-snapshot.js";
import { cacheStats, loadCachedDigest, MEMORY_PROMPT_BUDGET_BYTES, projectKey, renderMemoryPrompt, saveDigest } from "./memory-cache.js";
import { formatStatus, type KanbanStatusSnapshot } from "./status.js";
import { diffDigests, formatTaste, formatTasteNotice } from "./taste.js";
import { Transport } from "./transport.js";
import { registerNotify, type Notify } from "./notify.js";
import { TurnState } from "./turn-state.js";
import { runGate, type GateDeps } from "./gate.js";
import { staticText } from "./static-text.js";

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
		// Diff against the cached revision (the last state this machine saw) so
		// post-inspection pushes surface what was just mined, TASTE-row style.
		const previous = activeKey ? loadCachedDigest(agentDir(), activeKey) : null;
		activeProjectId = digest.projectId;
		activeDigest = digest;
		activePromptBlock = renderMemoryPrompt(digest, MEMORY_PROMPT_BUDGET_BYTES);
		const diff = diffDigests(previous, digest);
		if (diff) notify(formatTasteNotice(diff));
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
		return staticText(theme.fg("dim", text));
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

	// --- /taste: mined project memories and findings, display-only -----------

	const TASTE_ENTRY_TYPE = "pi-kanban-taste";
	pi.registerEntryRenderer(TASTE_ENTRY_TYPE, (entry, _options, theme) => {
		const text = (entry.data as { text?: string }).text ?? "";
		return staticText(theme.fg("dim", text));
	});
	pi.registerCommand("taste", {
		description: "Show project memories and recurring findings mined by pi-kanban inspections",
		handler: async (_args, ctx) => {
			const digest = activeDigest ?? (activeKey ? loadCachedDigest(agentDir(), activeKey) : null);
			const text = formatTaste({
				digest,
				totalTurns,
				injectedTurns,
				promptBlockBytes: activePromptBlock ? Buffer.byteLength(activePromptBlock) : 0,
				promptBudgetBytes: MEMORY_PROMPT_BUDGET_BYTES,
				now: Date.now(),
			});
			try {
				pi.appendEntry(TASTE_ENTRY_TYPE, { text });
			} catch {
				// Pre-session or non-interactive modes have no transcript to append to.
				ctx.ui.notify(text, "info");
			}
		},
	});

	// --- cross-project cloud search tool ---------------------------------

	const searchConfig = config.search ?? { enabled: true, timeoutSec: 20, maxResults: 10 };
	if (searchConfig.enabled) {
		registerKanbanSearch(pi, {
			connected: () => transport.connected,
			request: (query, scope, limit) => transport.requestSearch(query, scope, limit, searchConfig.timeoutSec * 1_000),
			maxResults: searchConfig.maxResults,
		});
	}

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

// --- kanban_search tool ---------------------------------------------------------

interface KanbanSearchDeps {
	connected: () => boolean;
	request: (query: string, scope: SearchScope, limit: number) => Promise<import("@pi-kanban/shared").SearchResponseMessage | null>;
	maxResults: number;
}

const KANBAN_SEARCH_PARAMETERS = {
	type: "object",
	properties: {
		query: {
			type: "string",
			minLength: 1,
			maxLength: 400,
			description: "Search terms; CJK text is supported. Quote exact phrases.",
		},
		scope: {
			type: "string",
			enum: ["all", "sessions", "memories"],
			description: "all (default), sessions (past session summaries), memories (decisions and memories)",
		},
		limit: { type: "integer", minimum: 1, maximum: 20, description: "Max hits per section" },
	},
	required: ["query"],
	additionalProperties: false,
} as const;

function formatKanbanSearchResponse(
	response: import("@pi-kanban/shared").SearchResponseMessage,
): string {
	if (!response.ok) return `Cloud search failed: ${response.error ?? "unknown error"}`;
	const { sessions, memories } = response.results;
	if (sessions.length === 0 && memories.length === 0) {
		return `No cloud matches. Full local transcripts are searchable with the session_search tool.`;
	}
	const lines: string[] = [];
	if (sessions.length > 0) {
		lines.push(`Sessions (${sessions.length}):`);
		for (const hit of sessions) {
			const name = hit.title ? `"${hit.title}" ` : "";
			lines.push(`• ${hit.sessionId.slice(0, 8)} ${name}@ ${hit.projectName} — score ${hit.score.toFixed(2)}`);
			if (hit.snippet) lines.push(`    …${truncate(hit.snippet.replace(/\s+/g, " "), 220)}`);
		}
	}
	if (memories.length > 0) {
		lines.push(`Memories and decisions (${memories.length}):`);
		for (const hit of memories) {
			lines.push(`• [${hit.kind}${hit.scope === "global" ? "/global" : ""}] (${hit.status}) ${truncate(hit.content, 240)} — ${hit.projectName}`);
		}
	}
	lines.push("", "Cloud results are summaries and decision points. For any session listed above, recover the full transcript with the local session_search tool (action read, session id prefix) when that session ran on this machine.");
	return lines.join("\n");
}

function registerKanbanSearch(pi: ExtensionAPI, deps: KanbanSearchDeps): void {
	pi.registerTool({
		name: "kanban_search",
		label: "Kanban Cloud Search",
		description:
			"Search the pi-kanban cloud for past sessions, memories and decision points across every project of this workspace. Returns ranked summaries with session/memory ids; read full transcripts locally via session_search.",
		promptSnippet: "Cross-project cloud search for past sessions and decisions (kanban_search)",
		promptGuidelines: [
			"Use kanban_search when prior decisions, past sessions, or work in OTHER projects is relevant to the current task.",
			"kanban_search works only while the cloud is reachable; offline it says so — then use the local session_search tool for sessions on this machine.",
			"For a kanban_search session hit that matters, follow up with session_search (action read) to recover the full transcript.",
		],
		parameters: KANBAN_SEARCH_PARAMETERS,
		async execute(_toolCallId: string, params: { query: string; scope?: string; limit?: number }, signal?: AbortSignal) {
			if (signal?.aborted) {
				return { content: [{ type: "text" as const, text: "Cancelled" }], details: {} };
			}
			// Offline = inert: no queueing, no network attempts, a clear fallback hint.
			if (!deps.connected()) {
				return {
					content: [{ type: "text" as const, text: "kanban cloud unreachable (offline). Search local sessions with the session_search tool instead." }],
					details: {},
			};
			}
			const scope: SearchScope = params.scope === "sessions" || params.scope === "memories" ? params.scope : "all";
			const limit = typeof params.limit === "number" && Number.isInteger(params.limit) ? params.limit : deps.maxResults;
			const response = await deps.request(params.query.slice(0, 400), scope, limit);
			const text = response == null
				? "kanban cloud did not answer within its timeout. Search local sessions with the session_search tool instead."
				: formatKanbanSearchResponse(response);
			return { content: [{ type: "text" as const, text }], details: {} };
		},
	});
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
