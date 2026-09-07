import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type {
	ApprovalDTO,
	BoardSession,
	DailyStatDTO,
	HistorySessionDTO,
	InspectionLogDetailDTO,
	InspectionLogSummaryDTO,
	LifetimeStatDTO,
	ModelSettingsInput,
	ProjectHistoryDTO,
	ProjectMemoryStatus,
	ProjectSnapshotFile,
	ProjectTreeNodeDTO,
	ProjectWorkDTO,
	RecentSessionDTO,
	SessionDetailDTO,
	SessionState,
	TodoProgress,
} from "@pi-kanban/shared";
import { db } from "./db/index.js";
import {
	agentTokens,
	approvals,
	messages,
	projectAnalysisStates,
	projectInspections,
	projectInspectionLogs,
	projectMemories,
	projects,
	projectSnapshots,
	sessions,
	todoLists,
	todos,
	toolCalls,
	turns,
	users,
} from "./db/schema.js";
import {
	authenticateAgentToken,
	authenticateWebToken,
	createWebSession,
	hashPassword,
	hashToken,
	isBootstrapToken,
	newSecret,
	revokeWebSession,
	validatePassword,
	validateUsername,
	verifyPassword,
	type AuthUser,
} from "./auth.js";
import { publish, subscribe, type BusEvent } from "./bus.js";
import { displayTurnPositions, mergeTurns } from "./merge-turns.js";
import { decideApproval } from "./approvals.js";
import { handleUpstream } from "./ingest.js";
import { sendToMachine } from "./ws.js";
import { connectionStats } from "./ws.js";
import {
	decryptApiKey,
	readModelSettings,
	saveModelSettings,
	toModelSettingsDto,
} from "./model-settings.js";
import { CONNECTION_TEST_TIMEOUT_MS, requestInspection, SYSTEM_PROMPT } from "./model.js";
import {
	ensureProjectAnalysisState,
	INSPECTION_LOCK_TTL_MS,
	queueProjectInspection,
	RETAINED_INSPECTION_LOGS,
	toMemoryDto,
} from "./inspector.js";
import { getLiveInspection, subscribeInspectionLive, type InspectionLiveEvent } from "./inspection-live.js";
import { addProjectReadCoverage, collectToolCallFiles, mergeSnapshotTree } from "./project-tree.js";

type AppEnv = { Variables: { auth: AuthUser } };
export const api = new Hono<AppEnv>();

// Liveness probe for containers/orchestrators; deliberately DB-free.
api.get("/health", (c) => c.json({ ok: true }));

const ACTIVE_STATES = ["running", "waiting_approval", "idle", "offline"];

/**
 * A session enters board/recent listings only once its task started — the
 * first prompt was submitted (turn_count > 0). A merely-opened pi session
 * would otherwise surface as an untitled card.
 */
function startedFilter(userId: string) {
	return and(eq(sessions.userId, userId), gt(sessions.turnCount, 0));
}

export function boardSessionFilter(userId: string) {
	const filter = startedFilter(userId);
	if (!filter) throw new Error("board filter requires a condition");
	return and(filter, inArray(sessions.state, ACTIVE_STATES));
}

function bearerToken(header: string | undefined): string | undefined {
	return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

function currentUser(c: { get(key: "auth"): AuthUser }): AuthUser {
	return c.get("auth");
}

function isAdmin(user: AuthUser): boolean {
	return user.role === "admin";
}

api.post("/api/auth/bootstrap", async (c) => {
	if (!process.env.ADMIN_TOKEN) return c.json({ error: "server misconfigured: ADMIN_TOKEN unset" }, 500);
	if (!isBootstrapToken(bearerToken(c.req.header("authorization")))) {
		return c.json({ error: "unauthorized" }, 401);
	}
	const existing = await db.select({ id: users.id }).from(users).limit(1);
	if (existing.length > 0) return c.json({ error: "bootstrap already completed" }, 409);
	const body = await c.req.json<{ username?: unknown; password?: unknown }>().catch(() => null);
	if (!body || !validateUsername(body.username) || !validatePassword(body.password)) {
		return c.json({ error: "username must be 3-40 characters; password must be at least 12 characters" }, 400);
	}
	const [user] = await db
		.insert(users)
		.values({ username: body.username, passwordHash: await hashPassword(body.password), role: "admin" })
		.returning({ id: users.id, username: users.username, role: users.role });
	const token = await createWebSession(user.id);
	return c.json({ token, user });
});

api.get("/api/auth/status", async (c) => {
	const existing = await db.select({ id: users.id }).from(users).limit(1);
	return c.json({ setupRequired: existing.length === 0 });
});

api.post("/api/auth/login", async (c) => {
	const body = await c.req.json<{ username?: unknown; password?: unknown }>().catch(() => null);
	if (!body || typeof body.username !== "string" || typeof body.password !== "string") {
		return c.json({ error: "invalid credentials" }, 401);
	}
	const [user] = await db
		.select({ id: users.id, username: users.username, passwordHash: users.passwordHash, role: users.role })
		.from(users)
		.where(eq(users.username, body.username))
		.limit(1);
	if (!user || !isAdminOrMember(user.role) || !(await verifyPassword(body.password, user.passwordHash))) {
		return c.json({ error: "invalid credentials" }, 401);
	}
	const token = await createWebSession(user.id);
	return c.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

/** EventSource cannot set request headers — these SSE endpoints accept the web token as ?token=. */
function acceptsQueryToken(path: string): boolean {
	return path === "/api/events" || path.endsWith("/inspection-log/stream");
}

api.use("/api/*", async (c, next) => {
	const token = bearerToken(c.req.header("authorization")) ?? (acceptsQueryToken(c.req.path) ? c.req.query("token") : undefined);
	if (!token) return c.json({ error: "unauthorized" }, 401);
	const user = await authenticateWebToken(token);
	if (!user) return c.json({ error: "unauthorized" }, 401);
	c.set("auth", user);
	await next();
});

api.get("/api/auth/me", (c) => c.json({ user: currentUser(c) }));

api.post("/api/auth/logout", async (c) => {
	const token = bearerToken(c.req.header("authorization"));
	if (token) await revokeWebSession(token);
	return c.json({ ok: true });
});

api.get("/api/settings/model", async (c) => {
	if (!isAdmin(currentUser(c))) return c.json({ error: "forbidden" }, 403);
	return c.json(toModelSettingsDto(await readModelSettings()));
});

api.post("/api/settings/model", async (c) => {
	if (!isAdmin(currentUser(c))) return c.json({ error: "forbidden" }, 403);
	const body = await c.req.json<ModelSettingsInput>().catch(() => null);
	if (!body) return c.json({ error: "invalid settings body" }, 400);
	try {
		return c.json(await saveModelSettings(body));
	} catch (error) {
		return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
	}
});

api.post("/api/settings/model/test", async (c) => {
	if (!isAdmin(currentUser(c))) return c.json({ error: "forbidden" }, 403);
	const settings = await readModelSettings();
	if (!settings?.apiKeyCipher || !settings.baseUrl || !settings.model) {
		return c.json({ error: "model connection is incomplete" }, 400);
	}
	try {
		await requestInspection(
			{ baseUrl: settings.baseUrl, model: settings.model, apiKey: decryptApiKey(settings.apiKeyCipher) },
			{ project: { name: "connection-test" }, sessions: [], knownMemories: [] },
			{ timeoutMs: CONNECTION_TEST_TIMEOUT_MS, purpose: "model connection test" },
		);
		return c.json({ ok: true });
	} catch (error) {
		return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
	}
});

api.get("/api/users", async (c) => {
	if (!isAdmin(currentUser(c))) return c.json({ error: "forbidden" }, 403);
	const rows = await db
		.select({ id: users.id, username: users.username, role: users.role, createdAt: users.createdAt })
		.from(users)
		.orderBy(users.createdAt);
	return c.json(rows.map((row) => ({ ...row, createdAt: row.createdAt.getTime() })));
});

api.post("/api/users", async (c) => {
	if (!isAdmin(currentUser(c))) return c.json({ error: "forbidden" }, 403);
	const body = await c.req.json<{ username?: unknown; password?: unknown; role?: unknown }>().catch(() => null);
	if (!body || !validateUsername(body.username) || !validatePassword(body.password)) {
		return c.json({ error: "username must be 3-40 characters; password must be at least 12 characters" }, 400);
	}
	const role = body.role === "admin" ? "admin" : "member";
	try {
		const [user] = await db
			.insert(users)
			.values({ username: body.username, passwordHash: await hashPassword(body.password), role })
			.returning({ id: users.id, username: users.username, role: users.role });
		return c.json({ user }, 201);
	} catch (error) {
		if (isUniqueViolation(error)) return c.json({ error: "username already exists" }, 409);
		throw error;
	}
});

api.get("/api/agent-tokens", async (c) => {
	const rows = await db
		.select({ id: agentTokens.id, name: agentTokens.name, createdAt: agentTokens.createdAt, lastUsedAt: agentTokens.lastUsedAt })
		.from(agentTokens)
		.where(and(eq(agentTokens.userId, currentUser(c).id), isNull(agentTokens.revokedAt)))
		.orderBy(desc(agentTokens.createdAt));
	return c.json(rows.map((row) => ({ ...row, createdAt: row.createdAt.getTime(), lastUsedAt: row.lastUsedAt?.getTime() })));
});

api.post("/api/agent-tokens", async (c) => {
	const body = await c.req.json<{ name?: unknown }>().catch(() => null);
	const name = typeof body?.name === "string" ? body.name.trim() : "";
	if (!name || name.length > 80) return c.json({ error: "token name must be 1-80 characters" }, 400);
	const token = newSecret();
	const [created] = await db
		.insert(agentTokens)
		.values({ userId: currentUser(c).id, name, tokenHash: hashToken(token) })
		.returning({ id: agentTokens.id, name: agentTokens.name, createdAt: agentTokens.createdAt });
	return c.json({ token, ...created, createdAt: created.createdAt.getTime() }, 201);
});

api.delete("/api/agent-tokens/:id", async (c) => {
	const [revoked] = await db
		.update(agentTokens)
		.set({ revokedAt: new Date() })
		.where(and(eq(agentTokens.id, c.req.param("id")), eq(agentTokens.userId, currentUser(c).id), isNull(agentTokens.revokedAt)))
		.returning({ id: agentTokens.id });
	return revoked ? c.body(null, 204) : c.json({ error: "token not found" }, 404);
});

// Stateless HTTP heartbeat: keeps sessions alive even while the WebSocket is
// down; see the plugin transport. Lives outside /api/* on purpose — the /api/*
// middleware below authenticates web-session tokens only.
api.post("/agent/heartbeat", async (c) => {
	const agent = await authenticateAgentToken(bearerToken(c.req.header("authorization")) ?? "");
	if (!agent) return c.json({ error: "unauthorized" }, 401);
	const body = await c.req
		.json<{ machineId?: unknown; sessionIds?: unknown }>()
		.catch(() => null);
	if (
		!body ||
		typeof body.machineId !== "string" ||
		!body.machineId ||
		!Array.isArray(body.sessionIds) ||
		!body.sessionIds.every((s) => typeof s === "string")
	) {
		return c.json({ error: "body must be {machineId: string, sessionIds: string[]}" }, 400);
	}
	await handleUpstream(
		{ type: "heartbeat", sessionIds: body.sessionIds, timestamp: Date.now() },
		{ machineId: body.machineId, userId: agent.userId },
	);
	return c.json({ ok: true, serverTime: Date.now() });
});

api.get("/api/board", async (c) => {
	const rows = await db
		.select({
			id: sessions.id,
			state: sessions.state,
			machineId: sessions.machineId,
			projectId: sessions.projectId,
			projectName: projects.name,
			cwd: sessions.cwd,
			branch: sessions.branch,
			title: sessions.title,
			modelId: sessions.modelId,
			totalCostUsd: sessions.totalCostUsd,
			turnCount: sessions.turnCount,
			inputTokens: sessions.inputTokens,
			cacheReadTokens: sessions.cacheReadTokens,
			totalTokens: sessions.totalTokens,
			contextTokens: sessions.contextTokens,
			contextWindow: sessions.contextWindow,
			startedAt: sessions.startedAt,
			lastActivityAt: sessions.lastActivityAt,
		})
		.from(sessions)
		.leftJoin(projects, eq(sessions.projectId, projects.id))
		.where(boardSessionFilter(currentUser(c).id))
		.orderBy(desc(sessions.lastActivityAt));
	return c.json(await toBoardSessions(rows));
});

api.get("/api/stats/daily", async (c) => {
	const daysParam = Number(c.req.query("days") ?? "14");
	// 200 days covers a ~28-week contribution heatmap.
	const days = Number.isInteger(daysParam) ? Math.min(Math.max(daysParam, 1), 200) : 14;
	const rows = await db
		.select({
			day: sql<string>`to_char(date_trunc('day', ${sessions.startedAt}), 'YYYY-MM-DD')`,
			sessionCount: sql<number>`count(${sessions.id})::int`,
			turnCount: sql<number>`coalesce(sum(${sessions.turnCount}), 0)::int`,
			totalCostUsd: sql<number>`coalesce(sum(${sessions.totalCostUsd}), 0)::float8`,
			totalTokens: sql<number>`coalesce(sum(${sessions.totalTokens}), 0)::float8`,
		})
		.from(sessions)
		.where(
			and(
				eq(sessions.userId, currentUser(c).id),
				sql`${sessions.startedAt} >= now() - make_interval(days => ${days})`,
			),
		)
		.groupBy(sql`date_trunc('day', ${sessions.startedAt})`)
		.orderBy(sql`date_trunc('day', ${sessions.startedAt})`);
	return c.json(rows satisfies DailyStatDTO[]);
});

api.get("/api/stats/total", async (c) => {
	const [row] = await db
		.select({
			totalCostUsd: sql<number>`coalesce(sum(${sessions.totalCostUsd}), 0)::float8`,
			totalTokens: sql<number>`coalesce(sum(${sessions.totalTokens}), 0)::float8`,
			totalProjects: sql<number>`count(distinct ${sessions.projectId})::int`,
			totalSessions: sql<number>`count(*)::int`,
		})
		.from(sessions)
		.where(eq(sessions.userId, currentUser(c).id));
	return c.json(row satisfies LifetimeStatDTO);
});

api.get("/api/sessions/recent", async (c) => {
	const rows = await db
		.select({
			id: sessions.id,
			title: sessions.title,
			state: sessions.state,
			projectName: projects.name,
			cwd: sessions.cwd,
			turnCount: sessions.turnCount,
			lastActivityAt: sessions.lastActivityAt,
		})
		.from(sessions)
		.leftJoin(projects, eq(sessions.projectId, projects.id))
		.where(startedFilter(currentUser(c).id))
		.orderBy(desc(sessions.lastActivityAt))
		.limit(5);
	const recent: RecentSessionDTO[] = rows.map((row) => ({
		id: row.id,
		title: row.title ?? undefined,
		state: row.state as SessionState,
		projectName: row.projectName ?? row.cwd,
		turnCount: row.turnCount,
		lastActivityAt: row.lastActivityAt.getTime(),
	}));
	return c.json(recent);
});

async function toBoardSessions(
	rows: Array<{
		id: string;
		state: string;
		machineId: string;
		projectId: number | null;
		projectName: string | null;
		cwd: string;
		branch: string | null;
		title: string | null;
		modelId: string | null;
		totalCostUsd: number;
		turnCount: number;
		inputTokens: number;
		cacheReadTokens: number;
		totalTokens: number;
		contextTokens: number;
		contextWindow: number;
		startedAt: Date;
		lastActivityAt: Date;
	}>,
): Promise<BoardSession[]> {
	if (rows.length === 0) return [];
	const ids = rows.map((row) => row.id);
	const [pending, todoProgress, lastMessages] = await Promise.all([
		db
			.select({ sessionId: approvals.sessionId, count: sql<number>`count(*)::int` })
			.from(approvals)
			.where(and(inArray(approvals.sessionId, ids), eq(approvals.status, "pending")))
			.groupBy(approvals.sessionId),
		activeTodoProgress(ids),
		db.execute(sql`
			select m.session_id, m.role, m.excerpt, m.position
			from messages m
			join (
				select session_id, max(position) as max_pos
				from messages where session_id = any(${sql.param(ids)}) group by session_id
			) latest on latest.session_id = m.session_id and latest.max_pos = m.position
		`) as Promise<Array<{ session_id: string; role: string; excerpt: string | null }>>,
	]);
	const pendingBySession = new Map(pending.map((row) => [row.sessionId, row.count]));
	const lastBySession = new Map(lastMessages.map((row) => [row.session_id, row]));
	return rows.map((row) => {
		const last = lastBySession.get(row.id);
		return {
			id: row.id,
			state: row.state as SessionState,
			machineId: row.machineId,
			projectName: row.projectName ?? row.cwd,
			projectId: row.projectId,
			cwd: row.cwd,
			branch: row.branch ?? undefined,
			title: row.title ?? undefined,
			modelId: row.modelId ?? undefined,
			totalCostUsd: row.totalCostUsd,
			turnCount: row.turnCount,
			inputTokens: row.inputTokens,
			cacheReadTokens: row.cacheReadTokens,
			totalTokens: row.totalTokens,
			contextTokens: row.contextTokens,
			contextWindow: row.contextWindow,
			startedAt: row.startedAt.getTime(),
			lastActivityAt: row.lastActivityAt.getTime(),
			pendingApprovals: pendingBySession.get(row.id) ?? 0,
			todo: todoProgress.get(row.id),
			lastMessage: last ? { role: last.role, excerpt: last.excerpt ?? "", timestamp: 0 } : undefined,
		};
	});
}

async function activeTodoProgress(sessionIds: string[]): Promise<Map<string, TodoProgress>> {
	const lists = await db
		.select({ id: todoLists.id, sessionId: todoLists.sessionId, createdAt: todoLists.createdAt })
		.from(todoLists)
		.where(and(inArray(todoLists.sessionId, sessionIds), isNull(todoLists.supersededAt)))
		.orderBy(desc(todoLists.createdAt));
	const newest = new Map<string, { id: number; createdAt: Date }>();
	for (const list of lists) {
		const current = newest.get(list.sessionId);
		if (!current || list.createdAt > current.createdAt) newest.set(list.sessionId, { id: list.id, createdAt: list.createdAt });
	}
	if (newest.size === 0) return new Map();
	const items = await db
		.select({ listId: todos.listId, content: todos.content, state: todos.state })
		.from(todos)
		.where(inArray(todos.listId, [...newest.values()].map((list) => list.id)));
	const progress = new Map<string, TodoProgress>();
	for (const [sessionId, list] of newest) {
		const listItems = items.filter((item) => item.listId === list.id);
		if (listItems.length === 0) continue;
		const done = listItems.filter((item) => ["done", "completed"].includes(item.state)).length;
		const current = listItems.find((item) => ["current", "in_progress"].includes(item.state));
		progress.set(sessionId, { done, total: listItems.length, current: current?.content });
	}
	return progress;
}

api.get("/api/approvals", async (c) => {
	const status = c.req.query("status");
	const rows = await db
		.select({
			id: approvals.id,
			sessionId: approvals.sessionId,
			toolName: approvals.toolName,
			input: approvals.input,
			policyLabel: approvals.policyLabel,
			status: approvals.status,
			localPrompted: approvals.localPrompted,
			requestedAt: approvals.requestedAt,
			decidedAt: approvals.decidedAt,
			decidedBy: approvals.decidedBy,
			note: approvals.note,
			sessionTitle: sessions.title,
			projectName: projects.name,
		})
		.from(approvals)
		.innerJoin(sessions, eq(approvals.sessionId, sessions.id))
		.leftJoin(projects, eq(sessions.projectId, projects.id))
		.where(and(eq(sessions.userId, currentUser(c).id), status ? eq(approvals.status, status) : undefined))
		.orderBy(desc(approvals.requestedAt))
		.limit(100);
	return c.json(toApprovalDtos(rows));
});

api.post("/api/approvals/:id/decision", async (c) => {
	const body = await c.req.json<{ decision: "approved" | "denied"; note?: string }>().catch(() => null);
	if (!body || (body.decision !== "approved" && body.decision !== "denied")) {
		return c.json({ error: "body must be {decision: 'approved' | 'denied', note?}" }, 400);
	}
	const [owned] = await db
		.select({ id: approvals.id })
		.from(approvals)
		.innerJoin(sessions, eq(approvals.sessionId, sessions.id))
		.where(and(eq(approvals.id, c.req.param("id")), eq(sessions.userId, currentUser(c).id)))
		.limit(1);
	if (!owned) return c.json({ error: "approval not found" }, 404);
	const user = currentUser(c);
	const result = await decideApproval(c.req.param("id"), body.decision, user.username, body.note, user.id, sendToMachine);
	return result.ok ? c.json(result) : c.json(result, 409);
});

api.get("/api/history", async (c) => {
	const rows = await db
		.select({
			id: projects.id,
			name: projects.name,
			gitRemote: projects.gitRemote,
			sessionCount: sql<number>`count(${sessions.id})::int`,
			totalCostUsd: sql<number>`coalesce(sum(${sessions.totalCostUsd}), 0)::float8`,
			// postgres-js hands back timestamptz aggregates as strings, not Dates
			lastActivityAt: sql<string | null>`max(${sessions.lastActivityAt})`,
		})
		.from(projects)
		.innerJoin(sessions, and(eq(sessions.projectId, projects.id), eq(sessions.userId, currentUser(c).id)))
		.groupBy(projects.id)
		.orderBy(desc(sql`max(${sessions.lastActivityAt})`));
	const dto: ProjectHistoryDTO[] = rows.map((row) => ({
		id: row.id,
		name: row.name,
		gitRemote: row.gitRemote ?? undefined,
		sessionCount: row.sessionCount,
		totalCostUsd: row.totalCostUsd,
		lastActivityAt: row.lastActivityAt ? new Date(row.lastActivityAt).getTime() : undefined,
	}));
	return c.json(dto);
});

api.get("/api/projects/:id/work", async (c) => {
	const projectId = Number(c.req.param("id"));
	if (!Number.isInteger(projectId)) return c.json({ error: "bad project id" }, 400);
	const userId = currentUser(c).id;
	const [owned] = await db
		.select({ id: projects.id, name: projects.name, gitRemote: projects.gitRemote })
		.from(projects)
		.innerJoin(sessions, and(eq(sessions.projectId, projects.id), eq(sessions.userId, userId)))
		.where(eq(projects.id, projectId))
		.limit(1);
	if (!owned) return c.json({ error: "project not found" }, 404);
	await ensureProjectAnalysisState(userId, projectId);
	const [memoryRows, stateRows, snapshotRows, readToolRows, settings] = await Promise.all([
		db.select().from(projectMemories).where(and(eq(projectMemories.userId, userId), eq(projectMemories.projectId, projectId), isNull(projectMemories.supersededAt))).orderBy(desc(projectMemories.createdAt)),
		db.select().from(projectAnalysisStates).where(and(eq(projectAnalysisStates.userId, userId), eq(projectAnalysisStates.projectId, projectId))).limit(1),
		db.select({ createdAt: projectSnapshots.createdAt, files: projectSnapshots.files }).from(projectSnapshots).where(and(eq(projectSnapshots.userId, userId), eq(projectSnapshots.projectId, projectId))).orderBy(desc(projectSnapshots.createdAt)).limit(1),
		db.select({ cwd: sessions.cwd, toolName: toolCalls.toolName, input: toolCalls.input }).from(toolCalls)
			.innerJoin(sessions, eq(toolCalls.sessionId, sessions.id))
			.where(and(eq(sessions.userId, userId), eq(sessions.projectId, projectId))),
		readModelSettings(),
	]);
	const state = stateRows[0];
	const snapshotFiles = asSnapshotFiles(snapshotRows[0]?.files);
	// Projects without a plugin snapshot still get a structure tree: derive it
	// from the file paths their sessions actually read or wrote.
	const files = snapshotFiles.length > 0 ? snapshotFiles : collectToolCallFiles(readToolRows);
	const latestTree = snapshotFiles.length > 0
		? asProjectTree(state?.latestTree)
		: mergeSnapshotTree(state?.latestTree, files, owned.name);
	const readCoverage = addProjectReadCoverage(latestTree, files, readToolRows);
	const dto: ProjectWorkDTO = {
		project: { id: owned.id, name: owned.name, gitRemote: owned.gitRemote ?? undefined },
		memories: memoryRows.map(toMemoryDto),
		tree: readCoverage.tree,
		coverage: {
			totalFiles: readCoverage.totalFiles,
			readFiles: readCoverage.readFiles,
			highConfidenceMemories: memoryRows.filter((memory) => memory.status === "confirmed" || memory.status === "pinned").length,
		},
		inspection: {
			enabled: settings?.enabled ?? false,
			intervalMinutes: settings?.inspectionIntervalMinutes ?? 60,
			running: Boolean(state?.lockedAt && Date.now() - state.lockedAt.getTime() < INSPECTION_LOCK_TTL_MS),
			lastRunAt: state?.lastInspectionAt?.getTime(),
			nextRunAt: state?.nextInspectionAt?.getTime(),
			lastError: state?.lastError ?? undefined,
		},
		snapshotUpdatedAt: snapshotRows[0]?.createdAt.getTime(),
	};
	return c.json(dto);
});

api.post("/api/projects/:id/inspect", async (c) => {
	const projectId = Number(c.req.param("id"));
	if (!Number.isInteger(projectId)) return c.json({ error: "bad project id" }, 400);
	const userId = currentUser(c).id;
	const [owned] = await db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.userId, userId), eq(sessions.projectId, projectId))).limit(1);
	if (!owned) return c.json({ error: "project not found" }, 404);
	try {
		const started = await queueProjectInspection(userId, projectId, "manual");
		return started ? c.json({ started: true }, 202) : c.json({ error: "inspection already running" }, 409);
	} catch (error) {
		return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
	}
});

/**
 * Runs listed from project_inspections (left-joined to its transcript):
 * a run that fails before any payload is assembled has no transcript row,
 * and an inner join would silently drop it from the history.
 */
export function inspectionLogListQuery(userId: string, projectId: number) {
	return db.select({
		inspectionId: projectInspections.id,
		trigger: projectInspections.trigger,
		status: projectInspections.status,
		startedAt: projectInspections.startedAt,
		finishedAt: projectInspections.finishedAt,
		redactionCount: projectInspections.redactionCount,
		error: projectInspections.error,
		// Presence flags only — the transcript texts can reach ~800KB per run and
		// are fetched by the detail endpoint on demand.
		hasResponse: sql<boolean>`(${projectInspectionLogs.responseContent} is not null)`,
		hasReasoning: sql<boolean>`(${projectInspectionLogs.reasoningContent} is not null)`,
	}).from(projectInspections)
		.leftJoin(projectInspectionLogs, eq(projectInspectionLogs.inspectionId, projectInspections.id))
		.where(and(eq(projectInspections.userId, userId), eq(projectInspections.projectId, projectId)))
		.orderBy(desc(projectInspections.startedAt))
		.limit(RETAINED_INSPECTION_LOGS);
}

api.get("/api/projects/:id/inspection-logs", async (c) => {
	const projectId = Number(c.req.param("id"));
	if (!Number.isInteger(projectId)) return c.json({ error: "bad project id" }, 400);
	const userId = currentUser(c).id;
	const [owned] = await db.select({ id: projects.id }).from(projects)
		.innerJoin(sessions, and(eq(sessions.projectId, projects.id), eq(sessions.userId, userId)))
		.where(eq(projects.id, projectId)).limit(1);
	if (!owned) return c.json({ error: "project not found" }, 404);
	const rows = await inspectionLogListQuery(userId, projectId);
	const logs: InspectionLogSummaryDTO[] = rows.map((row) => ({
		inspectionId: row.inspectionId,
		trigger: row.trigger as "manual" | "schedule",
		status: row.status,
		startedAt: row.startedAt.getTime(),
		finishedAt: row.finishedAt?.getTime(),
		redactionCount: row.redactionCount,
		hasResponse: Boolean(row.hasResponse),
		hasReasoning: Boolean(row.hasReasoning),
		error: row.error ?? undefined,
	}));
	return c.json(logs);
});

api.get("/api/projects/:id/inspection-logs/:inspectionId", async (c) => {
	const projectId = Number(c.req.param("id"));
	if (!Number.isInteger(projectId)) return c.json({ error: "bad project id" }, 400);
	const inspectionId = c.req.param("inspectionId");
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(inspectionId)) {
		return c.json({ error: "bad inspection id" }, 400);
	}
	const userId = currentUser(c).id;
	const [row] = await db.select({
		trigger: projectInspections.trigger,
		status: projectInspections.status,
		startedAt: projectInspections.startedAt,
		finishedAt: projectInspections.finishedAt,
		redactionCount: projectInspections.redactionCount,
		error: projectInspections.error,
		requestPayload: projectInspectionLogs.requestPayload,
		responseContent: projectInspectionLogs.responseContent,
		reasoningContent: projectInspectionLogs.reasoningContent,
	}).from(projectInspections)
		.leftJoin(projectInspectionLogs, eq(projectInspectionLogs.inspectionId, projectInspections.id))
		.where(and(
			eq(projectInspections.userId, userId),
			eq(projectInspections.projectId, projectId),
			eq(projectInspections.id, inspectionId),
		)).limit(1);
	if (!row) return c.json({ error: "log not found" }, 404);
	const detail: InspectionLogDetailDTO = {
		inspection: {
			inspectionId,
			trigger: row.trigger as "manual" | "schedule",
			status: row.status,
			startedAt: row.startedAt.getTime(),
			finishedAt: row.finishedAt?.getTime(),
			redactionCount: row.redactionCount,
			hasResponse: row.responseContent != null,
			hasReasoning: row.reasoningContent != null,
			error: row.error ?? undefined,
		},
		systemPrompt: SYSTEM_PROMPT,
		requestPayload: row.requestPayload,
		responseContent: row.responseContent ?? undefined,
		reasoningContent: row.reasoningContent ?? undefined,
	};
	return c.json(detail);
});

api.get("/api/projects/:id/inspection-log/stream", (c) => {
	const projectId = Number(c.req.param("id"));
	if (!Number.isInteger(projectId)) return c.json({ error: "bad project id" }, 400);
	const userId = currentUser(c).id;
	return streamSSE(c, async (stream) => {
		// Ownership check runs inside the stream: the handshake already answered 200.
		const [owned] = await db.select({ id: projects.id }).from(projects)
			.innerJoin(sessions, and(eq(sessions.projectId, projects.id), eq(sessions.userId, userId)))
			.where(eq(projects.id, projectId)).limit(1);
		if (!owned) {
			await stream.writeSSE({ event: "error", data: "project not found" });
			return;
		}
		let closed = false;
		stream.onAbort(() => {
			closed = true;
		});
		const sseEvent = (e: InspectionLiveEvent): { event: string; data: string } => ({
			event: "stage" in e ? "stage" : "type" in e ? "delta" : "snapshot",
			data: JSON.stringify(e),
		});
		// Events replayed synchronously during subscribe land in the buffer so the
		// run envelope is always written before its stages/snapshot.
		const buffered: InspectionLiveEvent[] = [];
		let flushing = false;
		const unsubscribe = subscribeInspectionLive(projectId, (e) => {
			if (closed) return;
			if (flushing) void stream.writeSSE(sseEvent(e));
			else buffered.push(e);
		});
		try {
			const live = getLiveInspection(projectId);
			await stream.writeSSE({
				event: "run",
				data: JSON.stringify(live ? { running: live.running, inspectionId: live.inspectionId, trigger: live.trigger, startedAt: live.startedAt } : { running: false }),
			});
			for (const e of buffered) await stream.writeSSE(sseEvent(e));
			buffered.length = 0;
			flushing = true;
			while (!closed) {
				await stream.writeSSE({ event: "ping", data: "" });
				await stream.sleep(25_000);
			}
		} finally {
			closed = true;
			unsubscribe();
		}
	});
});

api.post("/api/projects/:id/memories/:memoryId/status", async (c) => {
	const projectId = Number(c.req.param("id"));
	if (!Number.isInteger(projectId)) return c.json({ error: "bad project id" }, 400);
	const memoryId = c.req.param("memoryId");
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(memoryId)) {
		return c.json({ error: "bad memory id" }, 400);
	}
	const body = await c.req.json<{ status?: unknown }>().catch(() => null);
	const statuses: ProjectMemoryStatus[] = ["candidate", "confirmed", "pinned", "archived"];
	if (!body || !statuses.includes(body.status as ProjectMemoryStatus)) return c.json({ error: "invalid memory status" }, 400);
	const userId = currentUser(c).id;
	const [current] = await db.select().from(projectMemories).where(and(
		eq(projectMemories.memoryKey, memoryId),
		eq(projectMemories.projectId, projectId),
		eq(projectMemories.userId, userId),
		isNull(projectMemories.supersededAt),
	)).limit(1);
	if (!current) return c.json({ error: "memory not found" }, 404);
	const now = new Date();
	try {
		const created = await db.transaction(async (tx) => {
			const [superseded] = await tx.update(projectMemories).set({ supersededAt: now }).where(and(eq(projectMemories.id, current.id), isNull(projectMemories.supersededAt))).returning({ id: projectMemories.id });
			if (!superseded) throw new Error("memory version conflict");
			const [next] = await tx.insert(projectMemories).values({
				memoryKey: current.memoryKey,
				userId,
				projectId,
				version: current.version + 1,
				createdAt: current.createdAt,
				kind: current.kind,
				content: current.content,
				status: body.status as ProjectMemoryStatus,
				moduleIds: current.moduleIds,
				evidence: current.evidence,
				sourceInspectionId: current.sourceInspectionId,
			}).returning();
			return next;
		});
		publish({ type: "project_update", userId, projectId });
		return c.json(toMemoryDto(created));
	} catch (error) {
		if (isUniqueViolation(error) || (error instanceof Error && error.message === "memory version conflict")) {
			return c.json({ error: "memory was updated by another request" }, 409);
		}
		throw error;
	}
});

api.get("/api/projects/:id/sessions", async (c) => {
	const id = Number(c.req.param("id"));
	if (!Number.isInteger(id)) return c.json({ error: "bad project id" }, 400);
	const rows = await db
		.select({ id: sessions.id, title: sessions.title, state: sessions.state, turnCount: sessions.turnCount, totalCostUsd: sessions.totalCostUsd, startedAt: sessions.startedAt, endedAt: sessions.endedAt })
		.from(sessions)
		.where(and(eq(sessions.projectId, id), eq(sessions.userId, currentUser(c).id)))
		.orderBy(desc(sessions.startedAt))
		.limit(200);
	const dto: HistorySessionDTO[] = rows.map((row) => ({
		id: row.id,
		title: row.title ?? undefined,
		state: row.state as SessionState,
		turnCount: row.turnCount,
		totalCostUsd: row.totalCostUsd,
		startedAt: row.startedAt.getTime(),
		endedAt: row.endedAt?.getTime(),
	}));
	return c.json(dto);
});

api.get("/api/sessions/:id", async (c) => {
	const id = c.req.param("id");
	const [row] = await db
		.select({ session: sessions, projectName: projects.name })
		.from(sessions)
		.leftJoin(projects, eq(sessions.projectId, projects.id))
		.where(and(eq(sessions.id, id), eq(sessions.userId, currentUser(c).id)))
		.limit(1);
	if (!row) return c.json({ error: "session not found" }, 404);
	const [turnRows, messageRows, toolRows, approvalRows, usageRows] = await Promise.all([
		db.select().from(turns).where(eq(turns.sessionId, id)).orderBy(turns.position),
		db.select().from(messages).where(eq(messages.sessionId, id)).orderBy(desc(messages.position)).limit(300),
		db.select().from(toolCalls).where(eq(toolCalls.sessionId, id)).orderBy(toolCalls.startedAt),
		db.select().from(approvals).where(eq(approvals.sessionId, id)).orderBy(desc(approvals.requestedAt)).limit(50),
		// `messageRows` is capped at the latest 300; token totals need every row.
		db.select({ usage: messages.usage }).from(messages).where(eq(messages.sessionId, id)),
	]);
	const activeList = await db
		.select({ id: todoLists.id })
		.from(todoLists)
		.where(and(eq(todoLists.sessionId, id), isNull(todoLists.supersededAt)))
		.orderBy(desc(todoLists.createdAt))
		.limit(1);
	const todoRows = activeList.length > 0 ? await db.select().from(todos).where(eq(todos.listId, activeList[0].id)).orderBy(todos.position) : [];
	const totalTokens = usageRows.reduce((total, row) => total + (extractTotalTokens(row.usage) ?? 0), 0);
	const logicalTurns = mergeTurns(turnRows);
	const displayedTurnPosition = displayTurnPositions(logicalTurns);
	const session = row.session;
	const detail: SessionDetailDTO = {
		id: session.id,
		state: session.state as SessionState,
		machineId: session.machineId,
		projectName: row.projectName ?? session.cwd,
		projectId: session.projectId,
		cwd: session.cwd,
		branch: session.branch ?? undefined,
		title: session.title ?? undefined,
		modelId: session.modelId ?? undefined,
		totalCostUsd: session.totalCostUsd,
		turnCount: session.turnCount,
		startedAt: session.startedAt.getTime(),
		lastActivityAt: session.lastActivityAt.getTime(),
		pendingApprovals: approvalRows.filter((approval) => approval.status === "pending").length,
		lastMessage: undefined,
		inputTokens: session.inputTokens,
		cacheReadTokens: session.cacheReadTokens,
		contextTokens: session.contextTokens,
		contextWindow: session.contextWindow,
		// Aggregated columns cover pre-detail-cap history; fall back to the
		// message sum for rows written before token aggregation existed.
		totalTokens: session.totalTokens > 0 ? session.totalTokens : totalTokens,
		turns: logicalTurns,
		messages: messageRows.map((message) => ({
			position: message.position,
			turnPosition: message.turnPosition == null ? undefined : (displayedTurnPosition.get(message.turnPosition) ?? message.turnPosition),
			role: message.role,
			excerpt: message.excerpt ?? undefined,
			customType: message.customType ?? undefined,
			costUsd: message.costUsd ?? undefined,
			tokens: extractTotalTokens(message.usage),
			timestamp: message.createdAt.getTime(),
		})).reverse(),
		toolCalls: toolRows.map((tool) => ({
			toolCallId: tool.toolCallId,
			turnPosition: tool.turnPosition == null ? undefined : (displayedTurnPosition.get(tool.turnPosition) ?? tool.turnPosition),
			toolName: tool.toolName,
			input: tool.input,
			resultExcerpt: tool.resultExcerpt ?? undefined,
			isError: tool.isError ?? false,
			startedAt: tool.startedAt.getTime(),
			durationMs: tool.durationMs ?? undefined,
		})),
		todos: todoRows.map((todo) => ({ position: todo.position, content: todo.content, state: todo.state })),
		approvals: toApprovalDtos(approvalRows.map((approval) => ({ ...approval, sessionTitle: session.title, projectName: row.projectName }))),
	};
	return c.json(detail);
});

api.get("/api/events", (c) => {
	const userId = currentUser(c).id;
	return streamSSE(c, async (stream) => {
		let closed = false;
		const unsubscribe = subscribe((event: BusEvent) => {
			void eventBelongsToUser(event, userId).then((belongs) => {
				if (belongs && !closed) void stream.writeSSE({ event: "update", data: JSON.stringify(event) });
			});
		});
		stream.onAbort(() => {
			closed = true;
			unsubscribe();
		});
		while (!closed) {
			await stream.writeSSE({ event: "ping", data: String(connectionStats().machines) });
			await stream.sleep(25_000);
		}
	});
});

async function eventBelongsToUser(event: BusEvent, userId: string): Promise<boolean> {
	if (event.type === "project_update") return event.userId === userId;
	const [session] = await db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.id, event.sessionId), eq(sessions.userId, userId))).limit(1);
	return Boolean(session);
}

function toApprovalDtos(rows: Array<{
	id: string;
	sessionId: string;
	toolName: string;
	input: unknown;
	policyLabel: string;
	status: string;
	localPrompted: boolean;
	requestedAt: Date;
	decidedAt: Date | null;
	decidedBy: string | null;
	note: string | null;
	sessionTitle: string | null;
	projectName: string | null;
}>): ApprovalDTO[] {
	return rows.map((row) => ({
		id: row.id,
		sessionId: row.sessionId,
		projectName: row.projectName ?? undefined,
		sessionTitle: row.sessionTitle ?? undefined,
		toolName: row.toolName,
		input: row.input,
		policyLabel: row.policyLabel,
		status: row.status as ApprovalDTO["status"],
		localPrompted: row.localPrompted,
		requestedAt: row.requestedAt.getTime(),
		decidedAt: row.decidedAt?.getTime(),
		decidedBy: row.decidedBy ?? undefined,
		note: row.note ?? undefined,
	}));
}

function asSnapshotFiles(value: unknown): ProjectSnapshotFile[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((file) => {
		if (!file || typeof file !== "object" || typeof (file as { path?: unknown }).path !== "string") return [];
		return [{ path: (file as { path: string }).path }];
	});
}

function asProjectTree(value: unknown): ProjectTreeNodeDTO[] {
	if (!Array.isArray(value)) return [];
	return value.filter((node): node is ProjectTreeNodeDTO => Boolean(
		node && typeof node === "object" && typeof (node as { id?: unknown }).id === "string" && typeof (node as { label?: unknown }).label === "string",
	));
}

function isAdminOrMember(role: string): role is AuthUser["role"] {
	return role === "admin" || role === "member";
}

function isUniqueViolation(error: unknown): boolean {
	return (error as { cause?: { code?: string } })?.cause?.code === "23505";
}

function extractTotalTokens(usage: unknown): number | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const value = usage as Record<string, unknown>;
	const parts = [value.input, value.output, value.cacheRead, value.cacheWrite].filter((part): part is number => typeof part === "number" && Number.isFinite(part));
	return parts.length > 0 ? parts.reduce((sum, part) => sum + part, 0) : undefined;
}

// Production image only: serve the built SPA from apps/web/dist so one port
// serves UI, API, and WS. In dev the directory is absent and vite serves the
// UI itself. serveStatic resolves paths against process.cwd(), so rebase the
// root from this file's location.
const webDistDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDistDir)) {
	const webRoot = path.relative(process.cwd(), webDistDir);
	// Unmatched /api and /agent requests must stay JSON 404s instead of
	// falling through to the SPA shell below.
	api.use("*", async (c, next) => {
		const p = c.req.path;
		if (p === "/api" || p.startsWith("/api/") || p === "/agent" || p.startsWith("/agent/")) {
			return c.json({ error: "not found" }, 404);
		}
		await next();
	});
	api.use("*", serveStatic({ root: webRoot }));
	// BrowserRouter client routes: anything still unmatched gets the shell.
	api.get("*", serveStatic({ path: path.join(webRoot, "index.html") }));
}
