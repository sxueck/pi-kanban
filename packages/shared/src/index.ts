/**
 * Wire protocol between the pi plugin (WebSocket client) and the pi-kanban
 * server, plus DTOs shared with the web dashboard.
 *
 * Upstream  = plugin -> server. Downstream = server -> plugin.
 */

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Upstream: plugin -> server
// ---------------------------------------------------------------------------

export interface HelloMessage {
	type: "hello";
	protocolVersion: number;
	pluginVersion: string;
	machineId: string;
	machineName?: string;
	agentToken: string;
	piVersion?: string;
}

export interface SessionStartMessage {
	type: "session_start";
	sessionId: string;
	cwd: string;
	gitRemote?: string;
	gitBranch?: string;
	/** Pi session name shown by /resume; null explicitly clears a prior title. */
	title?: string | null;
	reason: string;
	startedAt: number;
}

export interface SessionEndMessage {
	type: "session_end";
	sessionId: string;
	reason: string;
	endedAt: number;
}

export interface SessionTitleMessage {
	type: "session_title";
	sessionId: string;
	title: string | null;
}

export interface TurnStartMessage {
	type: "turn_start";
	sessionId: string;
	position: number;
	prompt: string;
	startedAt: number;
}

export interface TurnEndMessage {
	type: "turn_end";
	sessionId: string;
	position: number;
	endedAt: number;
	/** Prompt-submitted → first assistant token (pi message_start), ms. */
	ttftMs?: number;
}

export interface MessageReportMessage {
	type: "message";
	sessionId: string;
	turnPosition?: number;
	position: number;
	role: "user" | "assistant" | "toolResult" | "custom";
	/** Text excerpt; long content is truncated by the plugin per config. */
	excerpt?: string;
	customType?: string;
	/** Raw usage block from pi assistant messages (shape may vary by version). */
	usage?: unknown;
	costUsd?: number;
	modelId?: string;
	/** pi ctx.model.contextWindow, sent alongside usage so the server can rate context fill. */
	contextWindow?: number;
	timestamp: number;
}

export interface ToolCallReportMessage {
	type: "tool_call";
	sessionId: string;
	turnPosition?: number;
	toolCallId: string;
	toolName: string;
	/** Truncated input JSON. */
	input: unknown;
	startedAt: number;
}

export interface ToolResultReportMessage {
	type: "tool_result";
	sessionId: string;
	toolCallId: string;
	/** Truncated result text. */
	resultExcerpt?: string;
	isError: boolean;
	endedAt: number;
	durationMs?: number;
}

export interface ProjectSnapshotFile {
	/** Path relative to the project root. Source contents are never included. */
	path: string;
	size?: number;
}

export interface ProjectSnapshotMessage {
	type: "project_snapshot";
	sessionId: string;
	cwd: string;
	gitRemote?: string;
	gitBranch?: string;
	hash: string;
	files: ProjectSnapshotFile[];
	git: {
		head?: string;
		status: string[];
	};
	diagnostics: string[];
	truncated: boolean;
	createdAt: number;
}

/** Full todo/task-list snapshot (append-only versioned lists). */
export interface TodoSnapshotMessage {
	type: "todo_snapshot";
	sessionId: string;
	todos: Array<{ position: number; content: string; state: string }>;
	timestamp: number;
}

export interface ApprovalRequestMessage {
	type: "approval_request";
	requestId: string;
	sessionId: string;
	toolCallId?: string;
	toolName: string;
	input: unknown;
	policyLabel: string;
	/** True when a local TUI prompt is also open (race: first answer wins). */
	localPrompted: boolean;
	createdAt: number;
}

/** Local TUI answered before/without the cloud; for audit trail. */
export interface ApprovalLocalResolutionMessage {
	type: "approval_local_resolution";
	approvalId: string;
	sessionId: string;
	decision: "approved" | "denied";
	note?: string;
}

export interface HeartbeatMessage {
	type: "heartbeat";
	sessionIds: string[];
	timestamp: number;
}

/** Plugin asks for the memory digest of the project this session belongs to. */
export interface MemoryFetchMessage {
	type: "memory_fetch";
	sessionId: string;
}

export type UpstreamMessage =
	| HelloMessage
	| SessionStartMessage
	| SessionEndMessage
	| SessionTitleMessage
	| TurnStartMessage
	| TurnEndMessage
	| MessageReportMessage
	| ToolCallReportMessage
	| ToolResultReportMessage
	| ProjectSnapshotMessage
	| TodoSnapshotMessage
	| ApprovalRequestMessage
	| ApprovalLocalResolutionMessage
	| HeartbeatMessage
	| MemoryFetchMessage;

// ---------------------------------------------------------------------------
// Downstream: server -> plugin
// ---------------------------------------------------------------------------

export interface HelloAckMessage {
	type: "hello_ack";
	ok: boolean;
	error?: string;
	serverTime: number;
}

export interface ApprovalCreatedMessage {
	type: "approval_created";
	requestId: string;
	approvalId: string;
}

export interface ApprovalDecisionMessage {
	type: "approval_decision";
	approvalId: string;
	decision: "approved" | "denied";
	decidedBy?: string;
	note?: string;
}

export interface HeartbeatAckMessage {
	type: "heartbeat_ack";
	serverTime: number;
}

/** One injectable project memory; content was server-redacted before persistence. */
export interface MemoryDigestEntry {
	kind: ProjectMemoryKind;
	content: string;
	status: ProjectMemoryStatus;
	occurrenceCount: number;
	lastSeenAt: number;
}

export interface MemoryDigestFinding {
	kind: SessionFindingKind;
	severity: SessionFindingSeverity;
	summary: string;
	occurrenceCount: number;
	lastSeenAt: number;
}

/**
 * Bounded project-memory payload injected into pi sessions. Sent as the reply
 * to memory_fetch (sessionId echoes the requester) and pushed to machines with
 * live sessions after each successful inspection (sessionId omitted; plugins
 * match pushes by projectId learned from an earlier reply).
 */
export interface MemoryDigestMessage {
	type: "memory_digest";
	projectId: number;
	projectName: string;
	sessionId?: string;
	/** Short content hash (excludes generatedAt); equal revisions skip cache rewrites. */
	revision: string;
	generatedAt: number;
	memories: MemoryDigestEntry[];
	findings: MemoryDigestFinding[];
}

export interface ServerErrorMessage {
	type: "error";
	message: string;
}

export type DownstreamMessage =
	| HelloAckMessage
	| ApprovalCreatedMessage
	| ApprovalDecisionMessage
	| HeartbeatAckMessage
	| MemoryDigestMessage
	| ServerErrorMessage;

// ---------------------------------------------------------------------------
// Session states (server-derived)
// ---------------------------------------------------------------------------

export type SessionState =
	| "running" // a turn is active
	| "waiting_approval" // blocked on a pending approval
	| "idle" // session alive, no active turn
	| "offline" // heartbeat stale
	| "finished"; // session_shutdown received

export function isActiveState(state: SessionState): boolean {
	return state !== "finished";
}

// ---------------------------------------------------------------------------
// REST DTOs (server -> web)
// ---------------------------------------------------------------------------

export interface TodoProgress {
	done: number;
	total: number;
	current?: string;
}

export interface BoardSession {
	id: string;
	state: SessionState;
	machineId: string;
	projectName: string;
	projectId: number | null;
	cwd: string;
	branch?: string;
	title?: string;
	modelId?: string;
	totalCostUsd: number;
	turnCount: number;
	startedAt: number;
	lastActivityAt: number;
	pendingApprovals: number;
	/** Cumulative fresh (uncached) input tokens across the session. */
	inputTokens?: number;
	/** Cumulative tokens served from the provider prompt cache. */
	cacheReadTokens?: number;
	/** Cumulative input+output+cache tokens across the session. */
	totalTokens?: number;
	/** Context size reported by the most recent assistant message. */
	contextTokens?: number;
	/** Model context window; 0/undefined when the plugin/model did not report one. */
	contextWindow?: number;
	todo?: TodoProgress;
	lastMessage?: {
		role: string;
		excerpt: string;
		timestamp: number;
	};
}

export interface ApprovalDTO {
	id: string;
	sessionId: string;
	projectName?: string;
	sessionTitle?: string;
	toolName: string;
	input: unknown;
	policyLabel: string;
	status: "pending" | "approved" | "denied" | "expired" | "local_resolved";
	localPrompted: boolean;
	requestedAt: number;
	decidedAt?: number;
	decidedBy?: string;
	note?: string;
}

export interface ProjectHistoryDTO {
	id: number;
	name: string;
	gitRemote?: string;
	sessionCount: number;
	totalCostUsd: number;
	lastActivityAt?: number;
}

export interface UserDTO {
	id: string;
	username: string;
	role: "admin" | "member";
	createdAt?: number;
}

export interface AgentTokenDTO {
	id: string;
	name: string;
	createdAt: number;
	lastUsedAt?: number;
}

export interface RecentSessionDTO {
	id: string;
	title?: string;
	state: SessionState;
	projectName: string;
	turnCount: number;
	lastActivityAt: number;
}

/** One bucket of the daily activity series; `day` is YYYY-MM-DD (UTC). */
export interface DailyStatDTO {
	day: string;
	sessionCount: number;
	turnCount: number;
	totalCostUsd: number;
	totalTokens: number;
}

/** Lifetime aggregates across every session of the account, finished ones included. */
export interface LifetimeStatDTO {
	totalCostUsd: number;
	totalTokens: number;
	/** Distinct projects ever seen across all sessions. */
	totalProjects: number;
	totalSessions: number;
}

export type ProjectMemoryStatus = "candidate" | "confirmed" | "pinned" | "archived";
export type ProjectMemoryKind = "fact" | "decision" | "preference" | "pattern" | "issue";

export interface ProjectMemoryDTO {
	id: string;
	version: number;
	kind: ProjectMemoryKind;
	content: string;
	status: ProjectMemoryStatus;
	moduleIds: string[];
	evidence: Array<{ sessionId: string; turnPosition?: number }>;
	/** How many inspections re-evidenced this memory (>=1). */
	occurrenceCount: number;
	createdAt: number;
	/** When the latest inspection last re-evidenced this memory. */
	lastSeenAt: number;
}

export type SessionFindingKind = "intent_drift" | "context_gap" | "tool_misuse" | "model_error";
export type SessionFindingSeverity = "info" | "warning" | "error";

/** Session-behavior finding extracted by an inspection (wish 2 output). */
export interface SessionFindingDTO {
	id: number;
	kind: SessionFindingKind;
	severity: SessionFindingSeverity;
	/** One-line summary, <=300 chars. */
	summary: string;
	detail?: string;
	/** Primary session the finding is about, when attributable to one. */
	sessionId?: string;
	turnPosition?: number;
	evidence: Array<{ sessionId: string; turnPosition?: number }>;
	occurrenceCount: number;
	createdAt: number;
	lastSeenAt: number;
}

export type ProjectTreeNodeKind = "project" | "module" | "file" | "decision" | "milestone" | "issue" | "evidence";

export interface ProjectTreeNodeDTO {
	id: string;
	parentId?: string;
	kind: ProjectTreeNodeKind;
	label: string;
	detail?: string;
	/** File count under a structural directory node; localized by the client. */
	fileCount?: number;
	severity?: "info" | "warning" | "error";
	sessionId?: string;
	turnPosition?: number;
	/** Snapshot files under this structural node and files read in project sessions. */
	coverage?: { totalFiles: number; readFiles: number };
}

export interface ProjectCoverageDTO {
	totalFiles: number;
	readFiles: number;
	highConfidenceMemories: number;
}

export interface ProjectInspectionDTO {
	enabled: boolean;
	/** Daily start time (minutes after local midnight), when enabled. */
	startMinute: number;
	/** Admin excluded this project from scheduled inspections. */
	excluded: boolean;
	/** Sessions of this project; below MIN_INSPECTION_SESSIONS scheduling pauses. */
	sessionCount: number;
	running: boolean;
	lastRunAt?: number;
	nextRunAt?: number;
	lastError?: string;
}

/** Live stage of an in-flight inspection run, streamed over SSE to the log panel. */
export type InspectionStageEvent =
	| { stage: "assembled"; inspectionId: string; bytes: number; redactions: number; omitted: Record<string, number> }
	| { stage: "request_sent"; inspectionId: string; model: string; timeoutMs: number }
	| { stage: "tool_completed"; inspectionId: string; tool: string; round: number; status: "completed" | "rejected"; resultBytes: number; redactions: number }
	| { stage: "succeeded"; inspectionId: string; memories: number; treeNodes: number; findings: number; elapsedMs: number }
	| { stage: "failed"; inspectionId: string; error: string; elapsedMs: number };

/** One streamed model token batch, forwarded verbatim to the log panel. */
export interface InspectionDelta {
	type: "reasoning" | "content";
	text: string;
}

/** SSE delta event on the inspection-log stream. */
export interface InspectionDeltaEvent extends InspectionDelta {
	inspectionId: string;
}

/** Replay of the text buffered so far for a running inspection, sent on subscribe. */
export interface InspectionSnapshotEvent {
	inspectionId: string;
	reasoning?: string;
	content?: string;
}

/** One row of the inspection log history list. */
export interface InspectionLogSummaryDTO {
	inspectionId: string;
	trigger: "manual" | "schedule";
	status: string;
	startedAt: number;
	finishedAt?: number;
	redactionCount: number;
	/** A response never arrived (request failed or timed out). */
	hasResponse: boolean;
	hasReasoning: boolean;
	error?: string;
}

/** Full transcript of one inspection run, as displayed by the log panel. */
export interface InspectionLogDetailDTO {
	inspection: InspectionLogSummaryDTO;
	systemPrompt: string;
	requestPayload: unknown;
	responseContent?: string;
	reasoningContent?: string;
}

export interface ProjectWorkDTO {
	project: { id: number; name: string; gitRemote?: string };
	memories: ProjectMemoryDTO[];
	tree: ProjectTreeNodeDTO[];
	findings: SessionFindingDTO[];
	coverage: ProjectCoverageDTO;
	inspection: ProjectInspectionDTO;
	snapshotUpdatedAt?: number;
}

/** Scheduled inspections skip projects with fewer live sessions than this. */
export const MIN_INSPECTION_SESSIONS = 10;

/**
 * Daily inspection schedule: one run per allowed day, starting at startMinute
 * (minutes after local midnight, machine's local time zone).
 */
export interface InspectionSchedule {
	startMinute: number;
	/** Days of week the run is active, 0 = Sunday … 6 = Saturday (Date.getDay). */
	weekdays: number[];
}

/**
 * Next inspection slot strictly after `from`: the start time on the first
 * allowed day that has not yet passed it, evaluated in the machine's local
 * time zone. One run per day — a finished or failed run waits until the next
 * allowed day.
 */
export function computeNextInspectionAt(schedule: InspectionSchedule, from: Date): Date {
	const allowed = new Set(schedule.weekdays);
	for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
		// 8 local-day iterations always cover at least one allowed weekday,
		// even across DST transitions that shift the calendar day length.
		const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + dayOffset);
		if (!allowed.has(day.getDay())) continue;
		const slot = minuteOfDay(day, schedule.startMinute);
		if (slot.getTime() > from.getTime()) return slot;
	}
	// Unreachable when weekdays is non-empty (validated at the settings boundary).
	return new Date(from.getTime() + 86_400_000);
}

function minuteOfDay(midnight: Date, minutes: number): Date {
	return new Date(
		midnight.getFullYear(),
		midnight.getMonth(),
		midnight.getDate() + Math.floor(minutes / 1440),
		Math.floor((minutes % 1440) / 60),
		minutes % 60,
	);
}

export interface ModelSettingsDTO {
	baseUrl: string;
	model: string;
	enabled: boolean;
	startMinute: number;
	weekdays: number[];
	/** Projects excluded from scheduled inspections (all others are included). */
	excludedProjectIds: number[];
	hasApiKey: boolean;
	updatedAt?: number;
}

export interface ModelSettingsInput {
	baseUrl: string;
	model: string;
	enabled: boolean;
	startMinute: number;
	weekdays: number[];
	excludedProjectIds: number[];
	/** Omit to keep the current key; an empty value clears it. */
	apiKey?: string;
}

/** Admin-facing project row for the inspection exclusion picker. */
export interface InspectionProjectDTO {
	id: number;
	name: string;
	sessionCount: number;
}

export interface HistorySessionDTO {
	id: string;
	title?: string;
	state: SessionState;
	turnCount: number;
	totalCostUsd: number;
	startedAt: number;
	endedAt?: number;
}

export interface TurnDTO {
	/** First raw turn position in this rendered logical turn. */
	position: number;
	/** Raw turn positions represented by this logical turn. */
	positions?: number[];
	prompt: string;
	state: "running" | "done";
	startedAt: number;
	endedAt?: number;
	/** Prompt-submitted → first assistant token, ms. */
	ttftMs?: number;
	/**
	 * Internal model steps merged into this logical turn. Legacy plugins sent
	 * one turn per agent-loop step (all sharing the prompt); the server
	 * collapses those, so steps > 1 marks legacy/merged rows.
	 */
	steps?: number;
}

export interface MessageDTO {
	position: number;
	turnPosition?: number;
	role: string;
	excerpt?: string;
	customType?: string;
	costUsd?: number;
	/** Total tokens (input + output, incl. cache) derived from raw usage. */
	tokens?: number;
	timestamp: number;
}

export interface ToolCallDTO {
	toolCallId: string;
	turnPosition?: number;
	toolName: string;
	input: unknown;
	resultExcerpt?: string;
	isError: boolean;
	startedAt: number;
	durationMs?: number;
}

export interface SessionDetailDTO extends BoardSession {
	turns: TurnDTO[];
	messages: MessageDTO[];
	toolCalls: ToolCallDTO[];
	todos: Array<{ position: number; content: string; state: string }>;
	approvals: ApprovalDTO[];
	/** Whole-session token total; `messages` is capped at the latest 300 rows. */
	totalTokens?: number;
}

// ---------------------------------------------------------------------------
// Plugin-side local config (~/.pi/agent/pi-kanban.json)
// ---------------------------------------------------------------------------

export interface GateRule {
	/**
	 * Tool scope of the rule ("bash", "powershell", ...). A scoped rule matches
	 * only command text executed under that scope: `input.command` for the
	 * tool itself, plus fused `then_run.command` on edit/write for bash (SoL-Pi
	 * Action Fusion). Omit to match any tool against the whole input JSON.
	 */
	tool?: string;
	/** Case-insensitive substring or regex source; see `tool` for the target. */
	match?: string;
	/** Regex flags for `match` (default "" — substring semantics via RegExp, i ). */
	flags?: string;
	label: string;
	/**
	 * Interactive tool (ask-user style): it already prompts at the TUI itself,
	 * so the gate skips its redundant local confirm and submits straight to the
	 * cloud approval queue. The tool_call hook fires for every tool — built-in
	 * or from any other extension — so covering a new blocking plugin is a rule
	 * here, not per-plugin code.
	 */
	interactive?: boolean;
}

export interface GateConfig {
	rules: GateRule[];
	/** Seconds a local TUI prompt waits before escalating to the cloud. */
	localTimeoutSec: number;
	/** Seconds to wait for a cloud decision before falling back. */
	cloudTimeoutSec: number;
	/** Fallback when both local and cloud fail to answer in time. */
	onTimeout: "deny" | "allow";
	/** Escalate to cloud when the session has no UI (headless rpc/json/-p). */
	escalateWhenHeadless: boolean;
}

export interface ReportConfig {
	/** Max characters of message/tool text kept per report. */
	excerptChars: number;
	/** Report tool inputs (potential secrets in commands — disable if worried). */
	reportToolInputs: boolean;
}

export interface PluginConfig {
	/** The agent token never lives here — it is read from PI_KANBAN_TOKEN. */
	server: { url: string };
	gate: GateConfig;
	report: ReportConfig;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}… [+${text.length - max} chars]`;
}
