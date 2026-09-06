import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { messages, projectSnapshots, sessions, toolCalls, turns } from "./db/schema.js";
import type {
	InspectionAgentTool,
	InspectionAgentToolCall,
	InspectionAgentToolExecution,
} from "./model.js";
import { redactForModel, type Redactable } from "./redact.js";

const MAX_SESSION_RESULTS = 20;
const MAX_TIMELINE_ITEMS = 100;
const MAX_FAILED_TOOL_RESULTS = 100;
const MAX_SNAPSHOT_FILES = 300;

export const INSPECTION_AGENT_TOOLS: InspectionAgentTool[] = [
	functionTool("list_sessions", "List recent sessions in this project. Use filters only when they narrow the investigation.", {
		type: "object",
		properties: {
			limit: { type: "integer", minimum: 1, maximum: MAX_SESSION_RESULTS },
			state: { type: "string", maxLength: 80 },
			hasFailedToolCall: { type: "boolean" },
		},
		additionalProperties: false,
	}),
	functionTool("get_session_timeline", "Read a bounded page of turns and message excerpts for one session in this project.", {
		type: "object",
		properties: {
			sessionId: { type: "string", minLength: 1, maxLength: 200 },
			page: { type: "integer", minimum: 1, maximum: 20 },
			limit: { type: "integer", minimum: 1, maximum: MAX_TIMELINE_ITEMS },
		},
		required: ["sessionId"],
		additionalProperties: false,
	}),
	functionTool("list_failed_tool_calls", "List failed Pi tool calls in this project, optionally narrowed to one owned session or tool name.", {
		type: "object",
		properties: {
			sessionId: { type: "string", minLength: 1, maxLength: 200 },
			toolName: { type: "string", minLength: 1, maxLength: 120 },
			limit: { type: "integer", minimum: 1, maximum: MAX_FAILED_TOOL_RESULTS },
		},
		additionalProperties: false,
	}),
	functionTool("get_snapshot_subtree", "Read a bounded directory subtree from the latest project snapshot. This returns file metadata only, never filesystem content.", {
		type: "object",
		properties: {
			path: { type: "string", maxLength: 500 },
			depth: { type: "integer", minimum: 0, maximum: 8 },
		},
		additionalProperties: false,
	}),
	functionTool("finalize_inspection", "Submit the final inspection result after collecting sufficient evidence. Call this exactly once and without another tool in the same response.", {
		type: "object",
		properties: {
			memories: { type: "array", maxItems: 20, items: { type: "object" } },
			tree: { type: "array", maxItems: 40, items: { type: "object" } },
		},
		required: ["memories", "tree"],
		additionalProperties: false,
	}),
];

export async function executeInspectionAgentTool(
	userId: string,
	projectId: number,
	call: InspectionAgentToolCall,
): Promise<InspectionAgentToolExecution> {
	try {
		switch (call.name) {
			case "list_sessions":
				return modelResult(await listSessions(userId, projectId, call.arguments), { source: "sessions" });
			case "get_session_timeline":
				return modelResult(await getSessionTimeline(userId, projectId, call.arguments), { source: "timeline" });
			case "list_failed_tool_calls":
				return modelResult(await listFailedToolCalls(userId, projectId, call.arguments), { source: "failed_tool_calls" });
			case "get_snapshot_subtree":
				return modelResult(await getSnapshotSubtree(userId, projectId, call.arguments), { source: "snapshot" });
			default:
				return rejectedResult();
		}
	} catch {
		return rejectedResult();
	}
}

function functionTool(name: string, description: string, parameters: Record<string, unknown>): InspectionAgentTool {
	return { type: "function", function: { name, description, parameters } };
}

async function listSessions(userId: string, projectId: number, args: Record<string, unknown>) {
	const limit = integer(args.limit, 10, 1, MAX_SESSION_RESULTS);
	const state = optionalString(args.state, 80);
	const rows = await db.select({
		id: sessions.id,
		title: sessions.title,
		branch: sessions.branch,
		state: sessions.state,
		turnCount: sessions.turnCount,
		lastActivityAt: sessions.lastActivityAt,
	}).from(sessions).where(and(
		eq(sessions.userId, userId),
		eq(sessions.projectId, projectId),
		...(state ? [eq(sessions.state, state)] : []),
	)).orderBy(desc(sessions.lastActivityAt)).limit(limit);
	const withFailures = await failedSessionIds(rows.map((row) => row.id));
	const filtered = args.hasFailedToolCall === true ? rows.filter((row) => withFailures.has(row.id)) : rows;
	return {
		sessions: filtered.map((row) => ({ ...row, lastActivityAt: row.lastActivityAt.toISOString(), hasFailedToolCall: withFailures.has(row.id) })),
		truncated: filtered.length === limit,
	};
}

async function getSessionTimeline(userId: string, projectId: number, args: Record<string, unknown>) {
	const sessionId = requiredString(args.sessionId, 200);
	const page = integer(args.page, 1, 1, 20);
	const limit = integer(args.limit, 40, 1, MAX_TIMELINE_ITEMS);
	const [session] = await db.select({ id: sessions.id, title: sessions.title, state: sessions.state }).from(sessions).where(and(
		eq(sessions.id, sessionId),
		eq(sessions.userId, userId),
		eq(sessions.projectId, projectId),
	)).limit(1);
	if (!session) throw new Error("session is outside this project");
	const offset = (page - 1) * limit;
	const [turnRows, messageRows] = await Promise.all([
		db.select({ position: turns.position, prompt: turns.prompt, state: turns.state, startedAt: turns.startedAt, endedAt: turns.endedAt })
			.from(turns).where(eq(turns.sessionId, sessionId)).orderBy(desc(turns.position)).limit(limit).offset(offset),
		db.select({ position: messages.position, turnPosition: messages.turnPosition, role: messages.role, excerpt: messages.excerpt, createdAt: messages.createdAt })
			.from(messages).where(eq(messages.sessionId, sessionId)).orderBy(desc(messages.position)).limit(limit).offset(offset),
	]);
	return {
		session,
		page,
		turns: turnRows.map((row) => ({ ...row, startedAt: row.startedAt.toISOString(), endedAt: row.endedAt?.toISOString() })),
		messages: messageRows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
	};
}

async function listFailedToolCalls(userId: string, projectId: number, args: Record<string, unknown>) {
	const limit = integer(args.limit, 30, 1, MAX_FAILED_TOOL_RESULTS);
	const sessionId = optionalString(args.sessionId, 200);
	const toolName = optionalString(args.toolName, 120);
	const rows = await db.select({
		sessionId: toolCalls.sessionId,
		turnPosition: toolCalls.turnPosition,
		toolName: toolCalls.toolName,
		input: toolCalls.input,
		result: toolCalls.resultExcerpt,
		startedAt: toolCalls.startedAt,
		durationMs: toolCalls.durationMs,
	}).from(toolCalls).innerJoin(sessions, eq(sessions.id, toolCalls.sessionId)).where(and(
		eq(sessions.userId, userId),
		eq(sessions.projectId, projectId),
		eq(toolCalls.isError, true),
		...(sessionId ? [eq(toolCalls.sessionId, sessionId)] : []),
		...(toolName ? [eq(toolCalls.toolName, toolName)] : []),
	)).orderBy(desc(toolCalls.startedAt), desc(toolCalls.id)).limit(limit);
	return { calls: rows.map((row) => ({ ...row, startedAt: row.startedAt.toISOString() })), truncated: rows.length === limit };
}

async function getSnapshotSubtree(userId: string, projectId: number, args: Record<string, unknown>) {
	const path = snapshotPath(args.path);
	const depth = integer(args.depth, 2, 0, 8);
	const [snapshot] = await db.select({ files: projectSnapshots.files, diagnostics: projectSnapshots.diagnostics, createdAt: projectSnapshots.createdAt, truncated: projectSnapshots.truncated })
		.from(projectSnapshots).where(and(eq(projectSnapshots.userId, userId), eq(projectSnapshots.projectId, projectId)))
		.orderBy(desc(projectSnapshots.createdAt)).limit(1);
	if (!snapshot) return { path, files: [], diagnostics: [], snapshotMissing: true };
	const rootSegments = path ? path.split("/").length : 0;
	const files = snapshotPaths(snapshot.files)
		.filter((file) => !path || file.path === path || file.path.startsWith(`${path}/`))
		.filter((file) => file.path.split("/").length <= rootSegments + depth + 1)
		.slice(0, MAX_SNAPSHOT_FILES);
	return {
		path,
		depth,
		files,
		diagnostics: snapshot.diagnostics,
		createdAt: snapshot.createdAt.toISOString(),
		truncated: snapshot.truncated || files.length === MAX_SNAPSHOT_FILES,
	};
}

async function failedSessionIds(sessionIds: string[]): Promise<Set<string>> {
	if (sessionIds.length === 0) return new Set();
	const rows = await db.selectDistinct({ sessionId: toolCalls.sessionId }).from(toolCalls)
		.where(and(eq(toolCalls.isError, true), inArray(toolCalls.sessionId, sessionIds)));
	return new Set(rows.map((row) => row.sessionId));
}

function modelResult(value: unknown, audit: Record<string, unknown>): InspectionAgentToolExecution {
	const redacted = redactForModel(toRedactable(value));
	return { content: redacted.value, redactionCount: redacted.count, audit };
}

function rejectedResult(): InspectionAgentToolExecution {
	return { content: { error: "tool request rejected" }, redactionCount: 0, audit: { reason: "rejected" } };
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error("invalid integer argument");
	return value;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error("invalid string argument");
	return value.trim();
}

function requiredString(value: unknown, maxLength: number): string {
	const result = optionalString(value, maxLength);
	if (!result) throw new Error("missing string argument");
	return result;
}

function snapshotPath(value: unknown): string {
	const raw = optionalString(value, 500) ?? "";
	const normalized = raw.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
	if (!normalized) return "";
	if (normalized.split("/").some((part) => part === "." || part === ".." || !part)) throw new Error("invalid snapshot path");
	return normalized;
}

function snapshotPaths(value: unknown): Array<{ path: string }> {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (!entry || typeof entry !== "object" || typeof (entry as { path?: unknown }).path !== "string") return [];
		const path = (entry as { path: string }).path.replaceAll("\\", "/").replace(/^\/+/, "");
		return path && !path.split("/").some((part) => part === "." || part === ".." || !part) ? [{ path }] : [];
	});
}

function toRedactable(value: unknown): Redactable {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map(toRedactable);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toRedactable(child)]));
	return String(value);
}
