import path from "node:path";
import { and, eq, isNull, sql } from "drizzle-orm";
import type {
	ApprovalCreatedMessage,
	DownstreamMessage,
	UpstreamMessage,
} from "@pi-kanban/shared";
import { truncate } from "@pi-kanban/shared";
import { db } from "./db/index.js";
import {
	approvals,
	machines,
	messages,
	projects,
	sessions,
	todoLists,
	toolCalls,
	todos,
	turns,
} from "./db/schema.js";
import { publish } from "./bus.js";

export interface ConnContext {
	machineId: string;
	machineName?: string;
}

const TITLE_MAX = 80;

export async function handleUpstream(
	msg: UpstreamMessage,
	conn: ConnContext,
): Promise<DownstreamMessage[]> {
	switch (msg.type) {
		case "session_start":
			await onSessionStart(msg, conn);
			return [];
		case "session_end":
			await onSessionEnd(msg);
			return [];
		case "turn_start":
			await onTurnStart(msg);
			return [];
		case "turn_end":
			await onTurnEnd(msg);
			return [];
		case "message":
			await onMessage(msg);
			return [];
		case "tool_call":
			await onToolCall(msg);
			return [];
		case "tool_result":
			await onToolResult(msg);
			return [];
		case "todo_snapshot":
			await onTodoSnapshot(msg);
			return [];
		case "approval_request":
			return [await onApprovalRequest(msg, conn)];
		case "approval_local_resolution":
			await onApprovalLocalResolution(msg);
			return [];
		case "heartbeat":
			await onHeartbeat(msg, conn);
			return [];
		default:
			return [];
	}
}

// --- project identity -------------------------------------------------------

async function resolveProjectId(
	cwd: string,
	gitRemote?: string,
): Promise<number> {
	if (gitRemote) {
		const existing = await db
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.gitRemote, gitRemote))
			.limit(1);
		if (existing.length > 0) {
			await db
				.update(projects)
				.set({ updatedAt: new Date() })
				.where(eq(projects.id, existing[0].id));
			return existing[0].id;
		}
		const [created] = await db
			.insert(projects)
			.values({
				name: projectNameFromRemote(gitRemote) ?? path.basename(cwd),
				gitRemote,
				primaryPath: cwd,
			})
			.onConflictDoUpdate({
				target: projects.gitRemote,
				set: { primaryPath: cwd, updatedAt: new Date() },
			})
			.returning({ id: projects.id });
		return created.id;
	}
	// No remote (not a git repo): group by cwd.
	const existing = await db
		.select({ id: projects.id })
		.from(projects)
		.where(eq(projects.primaryPath, cwd))
		.limit(1);
	if (existing.length > 0) return existing[0].id;
	const [created] = await db
		.insert(projects)
		.values({ name: path.basename(cwd) || cwd, primaryPath: cwd })
		.returning({ id: projects.id });
	return created.id;
}

function projectNameFromRemote(remote: string): string | undefined {
	// ssh: git@host:owner/repo.git  |  https://host/owner/repo.git
	const stripped = remote.replace(/\.git$/, "");
	const lastSegment = stripped.split(/[:/]/).filter(Boolean).at(-1);
	return lastSegment || undefined;
}

// --- event handlers ----------------------------------------------------------

async function onSessionStart(
	msg: Extract<UpstreamMessage, { type: "session_start" }>,
	conn: ConnContext,
) {
	const projectId = await resolveProjectId(msg.cwd, msg.gitRemote);
	await db
		.insert(sessions)
		.values({
			id: msg.sessionId,
			machineId: conn.machineId,
			projectId,
			cwd: msg.cwd,
			branch: msg.gitBranch,
			state: "idle",
			startedAt: new Date(msg.startedAt),
			lastActivityAt: new Date(msg.startedAt),
			lastHeartbeatAt: new Date(),
		})
		.onConflictDoUpdate({
			target: sessions.id,
			set: {
				machineId: conn.machineId,
				projectId,
				cwd: msg.cwd,
				branch: msg.gitBranch,
				// A resumed session re-enters the living set.
				state: sql`case when ${sessions.state} = 'finished' then 'idle' else ${sessions.state} end`,
				endedAt: null,
				endReason: null,
				lastHeartbeatAt: new Date(),
			},
		});
	publish({ type: "session_update", sessionId: msg.sessionId });
}

async function onSessionEnd(
	msg: Extract<UpstreamMessage, { type: "session_end" }>,
) {
	await db
		.update(sessions)
		.set({
			state: "finished",
			endedAt: new Date(msg.endedAt),
			endReason: msg.reason,
			lastActivityAt: new Date(msg.endedAt),
		})
		.where(eq(sessions.id, msg.sessionId));
	await db
		.update(turns)
		.set({ state: "done", endedAt: new Date(msg.endedAt) })
		.where(and(eq(turns.sessionId, msg.sessionId), eq(turns.state, "running")));
	publish({ type: "session_update", sessionId: msg.sessionId });
}

async function onTurnStart(
	msg: Extract<UpstreamMessage, { type: "turn_start" }>,
) {
	await db
		.insert(turns)
		.values({
			sessionId: msg.sessionId,
			position: msg.position,
			prompt: msg.prompt,
			state: "running",
			startedAt: new Date(msg.startedAt),
		})
		.onConflictDoUpdate({
			target: [turns.sessionId, turns.position],
			set: { state: "running", endedAt: null, startedAt: new Date(msg.startedAt) },
		});
	await db
		.update(sessions)
		.set({
			state: "running",
			lastActivityAt: new Date(msg.startedAt),
			title: sql`coalesce(${sessions.title}, ${truncate(msg.prompt, TITLE_MAX)})`,
			turnCount: sql`greatest(${sessions.turnCount}, ${msg.position})`,
		})
		.where(eq(sessions.id, msg.sessionId));
	publish({ type: "session_update", sessionId: msg.sessionId });
}

async function onTurnEnd(msg: Extract<UpstreamMessage, { type: "turn_end" }>) {
	await db
		.update(turns)
		.set({ state: "done", endedAt: new Date(msg.endedAt) })
		.where(
			and(eq(turns.sessionId, msg.sessionId), eq(turns.position, msg.position)),
		);
	await recomputeSessionState(msg.sessionId, new Date(msg.endedAt));
	publish({ type: "session_update", sessionId: msg.sessionId });
}

async function onMessage(msg: Extract<UpstreamMessage, { type: "message" }>) {
	await db
		.insert(messages)
		.values({
			sessionId: msg.sessionId,
			position: msg.position,
			turnPosition: msg.turnPosition ?? null,
			role: msg.role,
			excerpt: msg.excerpt ?? null,
			customType: msg.customType ?? null,
			usage: msg.usage ?? null,
			costUsd: msg.costUsd ?? null,
			modelId: msg.modelId ?? null,
			createdAt: new Date(msg.timestamp),
		})
		.onConflictDoNothing({ target: [messages.sessionId, messages.position] });
	const updates: Record<string, unknown> = {
		lastActivityAt: new Date(msg.timestamp),
	};
	if (msg.role === "assistant") {
		if (msg.costUsd != null) {
			updates.totalCostUsd = sql`${sessions.totalCostUsd} + ${msg.costUsd}`;
		}
		if (msg.modelId) updates.modelId = msg.modelId;
	}
	await db.update(sessions).set(updates).where(eq(sessions.id, msg.sessionId));
	publish({ type: "session_update", sessionId: msg.sessionId });
}

async function onToolCall(
	msg: Extract<UpstreamMessage, { type: "tool_call" }>,
) {
	await db
		.insert(toolCalls)
		.values({
			sessionId: msg.sessionId,
			toolCallId: msg.toolCallId,
			turnPosition: msg.turnPosition ?? null,
			toolName: msg.toolName,
			input: msg.input ?? null,
			startedAt: new Date(msg.startedAt),
		})
		.onConflictDoNothing({
			target: [toolCalls.sessionId, toolCalls.toolCallId],
		});
	publish({ type: "session_update", sessionId: msg.sessionId });
}

async function onToolResult(
	msg: Extract<UpstreamMessage, { type: "tool_result" }>,
) {
	await db
		.update(toolCalls)
		.set({
			resultExcerpt: msg.resultExcerpt ?? null,
			isError: msg.isError,
			endedAt: new Date(msg.endedAt),
			durationMs: msg.durationMs ?? null,
		})
		.where(
			and(
				eq(toolCalls.sessionId, msg.sessionId),
				eq(toolCalls.toolCallId, msg.toolCallId),
			),
		);
	publish({ type: "session_update", sessionId: msg.sessionId });
}

async function onTodoSnapshot(
	msg: Extract<UpstreamMessage, { type: "todo_snapshot" }>,
) {
	const now = new Date(msg.timestamp);
	// Supersede current active lists, then append the new snapshot.
	await db
		.update(todoLists)
		.set({ supersededAt: now })
		.where(and(eq(todoLists.sessionId, msg.sessionId), isNull(todoLists.supersededAt)));
	if (msg.todos.length > 0) {
		const [list] = await db
			.insert(todoLists)
			.values({ sessionId: msg.sessionId, createdAt: now })
			.returning({ id: todoLists.id });
		await db.insert(todos).values(
			msg.todos.map((t) => ({
				listId: list.id,
				position: t.position,
				content: t.content,
				state: t.state,
			})),
		);
	}
	await db
		.update(sessions)
		.set({ lastActivityAt: now })
		.where(eq(sessions.id, msg.sessionId));
	publish({ type: "session_update", sessionId: msg.sessionId });
}

async function onApprovalRequest(
	msg: Extract<UpstreamMessage, { type: "approval_request" }>,
	conn: ConnContext,
): Promise<ApprovalCreatedMessage> {
	const [row] = await db
		.insert(approvals)
		.values({
			sessionId: msg.sessionId,
			machineId: conn.machineId,
			toolCallId: msg.toolCallId ?? null,
			toolName: msg.toolName,
			input: msg.input ?? null,
			policyLabel: msg.policyLabel,
			localPrompted: msg.localPrompted,
			requestedAt: new Date(msg.createdAt),
		})
		.returning({ id: approvals.id });
	await db
		.update(sessions)
		.set({ state: "waiting_approval", lastActivityAt: new Date(msg.createdAt) })
		.where(
			and(
				eq(sessions.id, msg.sessionId),
				sql`${sessions.state} <> 'finished'`,
			),
		);
	publish({ type: "approval_update", approvalId: row.id, sessionId: msg.sessionId });
	return { type: "approval_created", requestId: msg.requestId, approvalId: row.id };
}

async function onApprovalLocalResolution(
	msg: Extract<UpstreamMessage, { type: "approval_local_resolution" }>,
) {
	await db
		.update(approvals)
		.set({
			status: "local_resolved",
			localDecision: msg.decision,
			decidedAt: new Date(),
			note: msg.note ?? null,
		})
		.where(and(eq(approvals.id, msg.approvalId), eq(approvals.status, "pending")));
	await recomputeSessionState(msg.sessionId);
	publish({ type: "approval_update", approvalId: msg.approvalId, sessionId: msg.sessionId });
}

async function onHeartbeat(
	msg: Extract<UpstreamMessage, { type: "heartbeat" }>,
	conn: ConnContext,
) {
	const now = new Date();
	await db
		.update(machines)
		.set({ lastSeenAt: now, name: conn.machineName ?? null })
		.where(eq(machines.id, conn.machineId));
	if (msg.sessionIds.length > 0) {
		await db
			.update(sessions)
			.set({ lastHeartbeatAt: now })
			.where(
				and(
					sql`${sessions.id} = any(${msg.sessionIds})`,
					sql`${sessions.state} <> 'finished'`,
				),
			);
	}
}

// --- state derivation ---------------------------------------------------------

/** Derive state from first principles: open approvals > open turn > idle. */
export async function recomputeSessionState(
	sessionId: string,
	at: Date = new Date(),
): Promise<void> {
	const [session] = await db
		.select({ state: sessions.state })
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	if (!session || session.state === "finished") return;

	const pending = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(approvals)
		.where(and(eq(approvals.sessionId, sessionId), eq(approvals.status, "pending")));
	const openTurns = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(turns)
		.where(and(eq(turns.sessionId, sessionId), eq(turns.state, "running")));

	const state =
		(pending[0]?.count ?? 0) > 0
			? "waiting_approval"
			: (openTurns[0]?.count ?? 0) > 0
				? "running"
				: "idle";
	await db
		.update(sessions)
		.set({ state, lastActivityAt: at })
		.where(eq(sessions.id, sessionId));
}
