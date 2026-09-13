import { and, eq, inArray, isNull } from "drizzle-orm";
import type { InspectionAgentTool, InspectionAgentToolCall, InspectionAgentToolExecution } from "./model.js";
import { db } from "./db/index.js";
import { projectMemories, projects, sessions } from "./db/schema.js";
import { searchUserContent } from "./search.js";
import { redactForModel, type Redactable } from "./redact.js";

/**
 * Read-only tools for the global consistency audit agent. Unlike the project
 * inspection tools these span every project of the authenticated user, but the
 * same discipline applies: bounded results, redacted before the model sees
 * them, untrusted as instructions.
 */

const MAX_MEMORY_RESULTS = 20;
const MAX_SESSION_RESULTS = 20;

export const GLOBAL_AGENT_TOOLS: InspectionAgentTool[] = [
	functionTool("search_memories", "Rank decision memories across all of this user's projects (and global principles) against a query. Results carry the memory ids usable in evidence.", {
		type: "object",
		properties: {
			query: { type: "string", minLength: 1, maxLength: 400 },
			scope: { type: "string", maxLength: 20, description: "project | global | all (default all)" },
			status: { type: "string", maxLength: 20, description: "candidate | confirmed | pinned (default confirmed+pinned)" },
			limit: { type: "integer", minimum: 1, maximum: MAX_MEMORY_RESULTS },
		},
		required: ["query"],
		additionalProperties: false,
	}),
	functionTool("search_sessions", "Rank past sessions across all of this user's projects against a query. Returns summaries (title, project, snippet) with session ids usable in evidence.", {
		type: "object",
		properties: {
			query: { type: "string", minLength: 1, maxLength: 400 },
			limit: { type: "integer", minimum: 1, maximum: MAX_SESSION_RESULTS },
		},
		required: ["query"],
		additionalProperties: false,
	}),
	functionTool("get_memory", "Read one memory in full (content, status, evidence session ids) by its id.", {
		type: "object",
		properties: {
			memoryId: { type: "string", minLength: 1, maxLength: 64 },
		},
		required: ["memoryId"],
		additionalProperties: false,
	}),
	functionTool("finalize_inspection", "Submit the final audit result: findings are direction_conflict items, memories are global principle candidates, tree must be an empty array. Call this exactly once and without another tool in the same response.", {
		type: "object",
		properties: {
			memories: { type: "array", maxItems: 20, items: { type: "object" } },
			tree: { type: "array", maxItems: 40, items: { type: "object" } },
			findings: { type: "array", maxItems: 10, items: { type: "object" } },
		},
		required: ["memories", "tree"],
		additionalProperties: false,
	}),
];

export async function executeGlobalInspectionAgentTool(
	userId: string,
	call: InspectionAgentToolCall,
): Promise<InspectionAgentToolExecution> {
	try {
		switch (call.name) {
			case "search_memories":
				return modelResult(await searchMemoriesTool(userId, call.arguments), { source: "memories" });
			case "search_sessions":
				return modelResult(await searchSessionsTool(userId, call.arguments), { source: "sessions" });
			case "get_memory":
				return modelResult(await getMemoryTool(userId, call.arguments), { source: "memory" });
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

async function searchMemoriesTool(userId: string, args: Record<string, unknown>) {
	const query = requiredString(args.query, 400);
	const limit = integer(args.limit, 10, 1, MAX_MEMORY_RESULTS);
	const scope = args.scope === "project" || args.scope === "global" ? args.scope : "all";
	const statusFilter = args.status === "candidate" || args.status === "confirmed" || args.status === "pinned"
		? [args.status]
		: ["confirmed", "pinned"];
	const result = await searchUserContent(userId, query, { scope: "memories", limit: MAX_MEMORY_RESULTS });
	const filtered = result.memories
		.filter((hit) => (scope === "all" ? true : (hit.scope ?? "project") === scope))
		.filter((hit) => statusFilter.includes(hit.status))
		.slice(0, limit);
	return {
		query,
		memories: filtered.map((hit) => ({
			id: hit.memoryId,
			projectId: hit.projectId ?? undefined,
			projectName: hit.projectName,
			kind: hit.kind,
			scope: hit.scope ?? "project",
			status: hit.status,
			content: hit.content,
		})),
	};
}

async function searchSessionsTool(userId: string, args: Record<string, unknown>) {
	const query = requiredString(args.query, 400);
	const limit = integer(args.limit, 10, 1, MAX_SESSION_RESULTS);
	const result = await searchUserContent(userId, query, { scope: "sessions", limit: MAX_SESSION_RESULTS });
	return {
		query,
		sessions: result.sessions.slice(0, limit).map((hit) => ({
			sessionId: hit.sessionId,
			title: hit.title,
			projectId: hit.projectId ?? undefined,
			projectName: hit.projectName,
			snippet: hit.snippet,
			matchedAt: new Date(hit.matchedAt).toISOString(),
		})),
	};
}

async function getMemoryTool(userId: string, args: Record<string, unknown>) {
	const memoryId = requiredString(args.memoryId, 64);
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(memoryId)) {
		throw new Error("invalid memory id");
	}
	const [row] = await db.select({
		memoryKey: projectMemories.memoryKey,
		scope: projectMemories.scope,
		projectId: projectMemories.projectId,
		kind: projectMemories.kind,
		content: projectMemories.content,
		status: projectMemories.status,
		occurrenceCount: projectMemories.occurrenceCount,
		evidence: projectMemories.evidence,
	}).from(projectMemories).where(and(
		eq(projectMemories.memoryKey, memoryId),
		eq(projectMemories.userId, userId),
		isNull(projectMemories.supersededAt),
	)).limit(1);
	if (!row) throw new Error("memory not found");
	const projectNames = row.projectId == null
		? Promise.resolve(new Map<number, string>())
		: db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, [row.projectId]))
			.then((rows) => new Map(rows.map((project) => [project.id, project.name])));
	const names = await projectNames;
	return {
		id: row.memoryKey,
		scope: row.scope,
		projectId: row.projectId ?? undefined,
		projectName: row.projectId == null ? "global" : names.get(row.projectId) ?? `project-${row.projectId}`,
		kind: row.kind,
		content: row.content,
		status: row.status,
		occurrenceCount: row.occurrenceCount,
		evidenceSessionIds: (Array.isArray(row.evidence) ? row.evidence : [])
			.flatMap((entry) => (entry && typeof entry === "object" && typeof (entry as { sessionId?: unknown }).sessionId === "string" ? [(entry as { sessionId: string }).sessionId] : []))
			.slice(0, 8),
	};
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

function requiredString(value: unknown, maxLength: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error("missing or invalid string argument");
	return value.trim();
}

function toRedactable(value: unknown): Redactable {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map(toRedactable);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toRedactable(child)]));
	return String(value);
}
