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
	| TodoSnapshotMessage
	| ApprovalRequestMessage
	| ApprovalLocalResolutionMessage
	| HeartbeatMessage;

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

export interface ServerErrorMessage {
	type: "error";
	message: string;
}

export type DownstreamMessage =
	| HelloAckMessage
	| ApprovalCreatedMessage
	| ApprovalDecisionMessage
	| HeartbeatAckMessage
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
	/** Tool name to match ("bash", "write", ...). Omit to match any tool. */
	tool?: string;
	/** Case-insensitive substring or regex source applied to the input JSON. */
	match?: string;
	/** Regex flags for `match` (default "" — substring semantics via RegExp, i ). */
	flags?: string;
	label: string;
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
