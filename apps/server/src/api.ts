import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type {
	ApprovalDTO,
	BoardSession,
	HistorySessionDTO,
	ProjectHistoryDTO,
	SessionDetailDTO,
	SessionState,
	TodoProgress,
} from "@pi-kanban/shared";
import { db } from "./db/index.js";
import {
	approvals,
	messages,
	projects,
	sessions,
	todoLists,
	todos,
	toolCalls,
	turns,
} from "./db/schema.js";
import { subscribe, type BusEvent } from "./bus.js";
import { decideApproval } from "./approvals.js";
import { sendToMachine } from "./ws.js";
import { connectionStats } from "./ws.js";

export const api = new Hono();

// --- auth --------------------------------------------------------------------

api.use("/api/*", async (c, next) => {
	const expected = process.env.ADMIN_TOKEN;
	if (!expected) return c.json({ error: "server misconfigured: ADMIN_TOKEN unset" }, 500);
	const header = c.req.header("authorization");
	const token = header?.startsWith("Bearer ") ? header.slice(7) : c.req.query("token");
	if (token !== expected) return c.json({ error: "unauthorized" }, 401);
	await next();
});

// --- board ---------------------------------------------------------------------

const ACTIVE_STATES = ["running", "waiting_approval", "idle", "offline"];

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
			startedAt: sessions.startedAt,
			lastActivityAt: sessions.lastActivityAt,
		})
		.from(sessions)
		.leftJoin(projects, eq(sessions.projectId, projects.id))
		.where(inArray(sessions.state, ACTIVE_STATES))
		.orderBy(desc(sessions.lastActivityAt));
	if (rows.length === 0) return c.json([] satisfies BoardSession[]);

	const ids = rows.map((r) => r.id);

	const pending = await db
		.select({ sessionId: approvals.sessionId, count: sql<number>`count(*)::int` })
		.from(approvals)
		.where(and(inArray(approvals.sessionId, ids), eq(approvals.status, "pending")))
		.groupBy(approvals.sessionId);
	const pendingBySession = new Map(pending.map((p) => [p.sessionId, p.count]));

	const todoProgress = await activeTodoProgress(ids);

	// SAFETY: drizzle's execute() types don't parametrize the row shape;
	// this raw lateral query always returns { session_id, role, excerpt }.
	const lastMessages = (await db.execute(sql`
		select m.session_id, m.role, m.excerpt, m.position
		from messages m
		join (
			select session_id, max(position) as max_pos
			from messages where session_id = any(${sql.param(ids)}) group by session_id
		) latest on latest.session_id = m.session_id and latest.max_pos = m.position
	`)) as unknown as Array<{ session_id: string; role: string; excerpt: string | null }>;
	const lastBySession = new Map(lastMessages.map((r) => [r.session_id, r]));

	const board: BoardSession[] = rows.map((r) => ({
		id: r.id,
		state: r.state as SessionState,
		machineId: r.machineId,
		projectName: r.projectName ?? r.cwd,
		projectId: r.projectId,
		cwd: r.cwd,
		branch: r.branch ?? undefined,
		title: r.title ?? undefined,
		modelId: r.modelId ?? undefined,
		totalCostUsd: r.totalCostUsd,
		turnCount: r.turnCount,
		startedAt: r.startedAt.getTime(),
		lastActivityAt: r.lastActivityAt.getTime(),
		pendingApprovals: pendingBySession.get(r.id) ?? 0,
		todo: todoProgress.get(r.id),
		lastMessage: (() => {
			const m = lastBySession.get(r.id);
			return m ? { role: m.role, excerpt: m.excerpt ?? "", timestamp: 0 } : undefined;
		})(),
	}));
	return c.json(board);
});

async function activeTodoProgress(sessionIds: string[]): Promise<Map<string, TodoProgress>> {
	const lists = await db
		.select({ id: todoLists.id, sessionId: todoLists.sessionId, createdAt: todoLists.createdAt })
		.from(todoLists)
		.where(and(inArray(todoLists.sessionId, sessionIds), isNull(todoLists.supersededAt)))
		.orderBy(desc(todoLists.createdAt));
	// newest active list per session (heartbeats may race supersede)
	const newest = new Map<string, { id: number; createdAt: Date }>();
	for (const l of lists) {
		const cur = newest.get(l.sessionId);
		if (!cur || l.createdAt > cur.createdAt) newest.set(l.sessionId, { id: l.id, createdAt: l.createdAt });
	}
	if (newest.size === 0) return new Map();

	const items = await db
		.select({
			listId: todos.listId,
			content: todos.content,
			state: todos.state,
		})
		.from(todos)
		.where(inArray(todos.listId, [...newest.values()].map((l) => l.id)));

	const progress = new Map<string, TodoProgress>();
	for (const [sessionId, list] of newest) {
		const listItems = items.filter((i) => i.listId === list.id);
		if (listItems.length === 0) continue;
		const done = listItems.filter((i) => ["done", "completed"].includes(i.state)).length;
		const current = listItems.find((i) => ["current", "in_progress"].includes(i.state));
		progress.set(sessionId, {
			done,
			total: listItems.length,
			current: current?.content,
		});
	}
	return progress;
}

// --- approvals -------------------------------------------------------------------

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
		.where(status ? eq(approvals.status, status) : undefined)
		.orderBy(desc(approvals.requestedAt))
		.limit(100);

	const dto: ApprovalDTO[] = rows.map((r) => ({
		id: r.id,
		sessionId: r.sessionId,
		projectName: r.projectName ?? undefined,
		sessionTitle: r.sessionTitle ?? undefined,
		toolName: r.toolName,
		input: r.input,
		policyLabel: r.policyLabel,
		status: r.status as ApprovalDTO["status"],
		localPrompted: r.localPrompted,
		requestedAt: r.requestedAt.getTime(),
		decidedAt: r.decidedAt?.getTime(),
		decidedBy: r.decidedBy ?? undefined,
		note: r.note ?? undefined,
	}));
	return c.json(dto);
});

api.post("/api/approvals/:id/decision", async (c) => {
	const body = await c.req.json<{ decision: "approved" | "denied"; note?: string }>().catch(() => null);
	if (!body || (body.decision !== "approved" && body.decision !== "denied")) {
		return c.json({ error: "body must be {decision: 'approved' | 'denied', note?}" }, 400);
	}
	const result = await decideApproval(
		c.req.param("id"),
		body.decision,
		"web",
		body.note,
		sendToMachine,
	);
	if (!result.ok) return c.json(result, 409);
	return c.json(result);
});

// --- history ---------------------------------------------------------------------

api.get("/api/history", async (c) => {
	const rows = await db
		.select({
			id: projects.id,
			name: projects.name,
			gitRemote: projects.gitRemote,
			sessionCount: sql<number>`count(${sessions.id})::int`,
			totalCostUsd: sql<number>`coalesce(sum(${sessions.totalCostUsd}), 0)::float8`,
			lastActivityAt: sql<Date | null>`max(${sessions.lastActivityAt})`,
		})
		.from(projects)
		.leftJoin(sessions, eq(sessions.projectId, projects.id))
		.groupBy(projects.id)
		.orderBy(desc(sql`max(${sessions.lastActivityAt})`));

	const dto: ProjectHistoryDTO[] = rows.map((r) => ({
		id: r.id,
		name: r.name,
		gitRemote: r.gitRemote ?? undefined,
		sessionCount: r.sessionCount,
		totalCostUsd: r.totalCostUsd,
		lastActivityAt: r.lastActivityAt ? new Date(r.lastActivityAt).getTime() : undefined,
	}));
	return c.json(dto);
});

api.get("/api/projects/:id/sessions", async (c) => {
	const id = Number(c.req.param("id"));
	if (!Number.isInteger(id)) return c.json({ error: "bad project id" }, 400);
	const rows = await db
		.select({
			id: sessions.id,
			title: sessions.title,
			state: sessions.state,
			turnCount: sessions.turnCount,
			totalCostUsd: sessions.totalCostUsd,
			startedAt: sessions.startedAt,
			endedAt: sessions.endedAt,
		})
		.from(sessions)
		.where(eq(sessions.projectId, id))
		.orderBy(desc(sessions.startedAt))
		.limit(200);
	const dto: HistorySessionDTO[] = rows.map((r) => ({
		id: r.id,
		title: r.title ?? undefined,
		state: r.state as SessionState,
		turnCount: r.turnCount,
		totalCostUsd: r.totalCostUsd,
		startedAt: r.startedAt.getTime(),
		endedAt: r.endedAt?.getTime(),
	}));
	return c.json(dto);
});

// --- session detail ----------------------------------------------------------------

api.get("/api/sessions/:id", async (c) => {
	const id = c.req.param("id");
	const [row] = await db
		.select({
			session: sessions,
			projectName: projects.name,
		})
		.from(sessions)
		.leftJoin(projects, eq(sessions.projectId, projects.id))
		.where(eq(sessions.id, id))
		.limit(1);
	if (!row) return c.json({ error: "session not found" }, 404);

	const [turnRows, messageRows, toolRows, approvalRows] = await Promise.all([
		db.select().from(turns).where(eq(turns.sessionId, id)).orderBy(turns.position),
		db
			.select()
			.from(messages)
			.where(eq(messages.sessionId, id))
			.orderBy(desc(messages.position))
			.limit(300),
		db.select().from(toolCalls).where(eq(toolCalls.sessionId, id)).orderBy(toolCalls.startedAt),
		db
			.select()
			.from(approvals)
			.where(eq(approvals.sessionId, id))
			.orderBy(desc(approvals.requestedAt))
			.limit(50),
	]);

	const pending = approvalRows.filter((a) => a.status === "pending").length;
	const activeList = await db
		.select({ id: todoLists.id })
		.from(todoLists)
		.where(and(eq(todoLists.sessionId, id), isNull(todoLists.supersededAt)))
		.orderBy(desc(todoLists.createdAt))
		.limit(1);
	const todoRows =
		activeList.length > 0
			? await db.select().from(todos).where(eq(todos.listId, activeList[0].id)).orderBy(todos.position)
			: [];

	const s = row.session;
	const detail: SessionDetailDTO = {
		id: s.id,
		state: s.state as SessionState,
		machineId: s.machineId,
		projectName: row.projectName ?? s.cwd,
		projectId: s.projectId,
		cwd: s.cwd,
		branch: s.branch ?? undefined,
		title: s.title ?? undefined,
		modelId: s.modelId ?? undefined,
		totalCostUsd: s.totalCostUsd,
		turnCount: s.turnCount,
		startedAt: s.startedAt.getTime(),
		lastActivityAt: s.lastActivityAt.getTime(),
		pendingApprovals: pending,
		lastMessage: undefined,
		turns: turnRows.map((t) => ({
			position: t.position,
			prompt: t.prompt,
			state: t.state as "running" | "done",
			startedAt: t.startedAt.getTime(),
			endedAt: t.endedAt?.getTime(),
		})),
		messages: messageRows
			.map((m) => ({
				position: m.position,
				turnPosition: m.turnPosition ?? undefined,
				role: m.role,
				excerpt: m.excerpt ?? undefined,
				customType: m.customType ?? undefined,
				costUsd: m.costUsd ?? undefined,
				timestamp: m.createdAt.getTime(),
			}))
			.reverse(),
		toolCalls: toolRows.map((t) => ({
			toolCallId: t.toolCallId,
			turnPosition: t.turnPosition ?? undefined,
			toolName: t.toolName,
			input: t.input,
			resultExcerpt: t.resultExcerpt ?? undefined,
			isError: t.isError ?? false,
			startedAt: t.startedAt.getTime(),
			durationMs: t.durationMs ?? undefined,
		})),
		todos: todoRows.map((t) => ({ position: t.position, content: t.content, state: t.state })),
		approvals: approvalRows.map((a) => ({
			id: a.id,
			sessionId: a.sessionId,
			projectName: row.projectName ?? undefined,
			sessionTitle: s.title ?? undefined,
			toolName: a.toolName,
			input: a.input,
			policyLabel: a.policyLabel,
			status: a.status as ApprovalDTO["status"],
			localPrompted: a.localPrompted,
			requestedAt: a.requestedAt.getTime(),
			decidedAt: a.decidedAt?.getTime(),
			decidedBy: a.decidedBy ?? undefined,
			note: a.note ?? undefined,
		})),
	};
	return c.json(detail);
});

// --- SSE ----------------------------------------------------------------------------

api.get("/api/events", (c) => {
	return streamSSE(c, async (stream) => {
		const unsubscribe = subscribe((event: BusEvent) => {
			void stream.writeSSE({ event: "update", data: JSON.stringify(event) });
		});
		let closed = false;
		stream.onAbort(() => {
			closed = true;
			unsubscribe();
		});
		// Keep-alive + drop silently-closed clients.
		while (!closed) {
			await stream.writeSSE({ event: "ping", data: String(connectionStats().machines) });
			await stream.sleep(25_000);
		}
	});
});
