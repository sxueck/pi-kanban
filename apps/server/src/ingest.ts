import path from "node:path";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type {
	ApprovalCreatedMessage,
	DownstreamMessage,
	UpstreamMessage,
} from "@pi-kanban/shared";
import { db } from "./db/index.js";
import {
	approvals,
	machines,
	messages,
	projectAnalysisStates,
	projects,
	projectSnapshots,
	sessions,
	todoLists,
	toolCalls,
	todos,
	turns,
} from "./db/schema.js";
import { publish } from "./bus.js";
import { mergeSnapshotTree } from "./project-tree.js";

export interface ConnContext {
	machineId: string;
	machineName?: string;
	userId: string;
}

export async function handleUpstream(
	msg: UpstreamMessage,
	conn: ConnContext,
): Promise<DownstreamMessage[]> {
	const sessionId = sessionIdFrom(msg);
	if (sessionId && msg.type !== "session_start" && !(await sessionBelongsToUser(sessionId, conn.userId))) {
		throw new Error("session does not belong to the authenticated agent user");
	}
	switch (msg.type) {
		case "session_start":
			await onSessionStart(msg, conn);
			return [];
		case "session_end":
			await onSessionEnd(msg);
			return [];
		case "session_title":
			await onSessionTitle(msg);
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
		case "project_snapshot":
			await onProjectSnapshot(msg, conn);
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
			return [await onHeartbeat(msg, conn)];
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
	const existing = await db
		.select({ userId: sessions.userId })
		.from(sessions)
		.where(eq(sessions.id, msg.sessionId))
		.limit(1);
	if (existing[0] && existing[0].userId !== conn.userId) {
		throw new Error("session id belongs to another user");
	}
	await db
		.insert(machines)
		.values({ id: conn.machineId, userId: conn.userId, name: conn.machineName ?? null, lastSeenAt: new Date() })
		.onConflictDoUpdate({
			target: machines.id,
			set: { userId: conn.userId, name: conn.machineName ?? null, lastSeenAt: new Date() },
		});
	const projectId = await resolveProjectId(msg.cwd, msg.gitRemote);
	await db
		.insert(sessions)
		.values({
			id: msg.sessionId,
			userId: conn.userId,
			machineId: conn.machineId,
			projectId,
			cwd: msg.cwd,
			branch: msg.gitBranch,
			title: msg.title ?? null,
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
				title: msg.title === undefined ? sessions.title : msg.title,
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

async function onSessionTitle(
	msg: Extract<UpstreamMessage, { type: "session_title" }>,
) {
	await db
		.update(sessions)
		.set({ title: msg.title })
		.where(eq(sessions.id, msg.sessionId));
	publish({ type: "session_update", sessionId: msg.sessionId });
}

async function onTurnStart(
	msg: Extract<UpstreamMessage, { type: "turn_start" }>,
) {
	const inserted = await db
		.insert(turns)
		.values({
			sessionId: msg.sessionId,
			position: msg.position,
			prompt: msg.prompt,
			state: "running",
			startedAt: new Date(msg.startedAt),
		})
		.onConflictDoNothing({ target: [turns.sessionId, turns.position] })
		.returning({ id: turns.id });
	await db
		.update(sessions)
		.set({
			state: "running",
			lastActivityAt: new Date(msg.startedAt),
			...(inserted.length > 0 ? { turnCount: sql`${sessions.turnCount} + 1` } : {}),
		})
		.where(eq(sessions.id, msg.sessionId));
	publish({ type: "session_update", sessionId: msg.sessionId });
}

async function onTurnEnd(msg: Extract<UpstreamMessage, { type: "turn_end" }>) {
	await db
		.update(turns)
		.set({
			state: "done",
			endedAt: new Date(msg.endedAt),
			...(msg.ttftMs != null ? { ttftMs: msg.ttftMs } : {}),
		})
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
		const usage = parseUsage(msg.usage);
		if (usage) {
			updates.inputTokens = sql`${sessions.inputTokens} + ${usage.input}`;
			updates.cacheReadTokens = sql`${sessions.cacheReadTokens} + ${usage.cacheRead}`;
			updates.totalTokens = sql`${sessions.totalTokens} + ${usage.total}`;
			// A completion's totalTokens approximates the context it was given.
			updates.contextTokens = usage.total;
		}
		if (msg.contextWindow != null) updates.contextWindow = msg.contextWindow;
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

async function onProjectSnapshot(
	msg: Extract<UpstreamMessage, { type: "project_snapshot" }>,
	conn: ConnContext,
) {
	if (!/^[a-f0-9]{64}$/i.test(msg.hash)) throw new Error("invalid project snapshot hash");
	if (!Array.isArray(msg.files)) throw new Error("invalid project snapshot files");
	const paths = new Set<string>();
	const files = msg.files.slice(0, 2_000).flatMap((file) => {
		if (!file || typeof file.path !== "string" || file.path.length > 500) return [];
		const normalized = file.path.replaceAll("\\", "/");
		if (normalized.startsWith("/") || /^[A-Z]:\//i.test(normalized) || normalized.split("/").includes("..") || paths.has(normalized)) return [];
		paths.add(normalized);
		return [{ path: normalized, size: typeof file.size === "number" && Number.isFinite(file.size) && file.size >= 0 ? file.size : undefined }];
	});
	const createdAtMs = Number.isFinite(msg.createdAt) && msg.createdAt > 0 && msg.createdAt <= 8_640_000_000_000_000
		? msg.createdAt
		: Date.now();
	const [session] = await db
		.select({ projectId: sessions.projectId })
		.from(sessions)
		.where(and(eq(sessions.id, msg.sessionId), eq(sessions.userId, conn.userId)))
		.limit(1);
	if (!session?.projectId) throw new Error("snapshot session has no project");
	const [project] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
	if (!project) throw new Error("snapshot project not found");
	await db
		.insert(projectSnapshots)
		.values({
			userId: conn.userId,
			projectId: session.projectId,
			sessionId: msg.sessionId,
			snapshotHash: msg.hash,
			files,
			git: {
				head: typeof msg.git?.head === "string" ? msg.git.head.slice(0, 200) : undefined,
				status: Array.isArray(msg.git?.status) ? msg.git.status.slice(0, 200).map((line) => String(line).slice(0, 500)) : [],
			},
			diagnostics: Array.isArray(msg.diagnostics) ? msg.diagnostics.slice(0, 100).map((line) => String(line).slice(0, 500)) : [],
			truncated: msg.truncated === true || msg.files.length > files.length,
			createdAt: new Date(createdAtMs),
		})
		.onConflictDoNothing({ target: [projectSnapshots.userId, projectSnapshots.projectId, projectSnapshots.snapshotHash] });
	const [analysisState] = await db
		.select({ latestTree: projectAnalysisStates.latestTree })
		.from(projectAnalysisStates)
		.where(and(eq(projectAnalysisStates.userId, conn.userId), eq(projectAnalysisStates.projectId, session.projectId)))
		.limit(1);
	// Fresh structure + preserved inspection insights: a snapshot must not
	// wipe the insight nodes the last inspection merged into latestTree.
	const latestTree = mergeSnapshotTree(analysisState?.latestTree, files, project.name);
	await db
		.insert(projectAnalysisStates)
		.values({
			userId: conn.userId,
			projectId: session.projectId,
			nextInspectionAt: new Date(),
			latestTree,
		})
		.onConflictDoUpdate({
			target: [projectAnalysisStates.userId, projectAnalysisStates.projectId],
			set: {
				nextInspectionAt: new Date(),
				latestTree,
				updatedAt: new Date(),
			},
		});
	publish({ type: "project_update", userId: conn.userId, projectId: session.projectId });
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
	await recomputeSessionState(msg.sessionId, new Date());
	publish({ type: "approval_update", approvalId: msg.approvalId, sessionId: msg.sessionId });
}

/** Refresh liveness timestamps; ack gives the plugin a downstream liveness signal. */
async function onHeartbeat(
	msg: Extract<UpstreamMessage, { type: "heartbeat" }>,
	conn: ConnContext,
): Promise<DownstreamMessage> {
	const now = new Date();
	await db
		.update(machines)
		.set({ userId: conn.userId, lastSeenAt: now, name: conn.machineName ?? null })
		.where(eq(machines.id, conn.machineId));
	if (msg.sessionIds.length > 0) {
		const owned = await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(and(or(...msg.sessionIds.map((id) => eq(sessions.id, id))), eq(sessions.userId, conn.userId), sql`${sessions.state} <> 'finished'`));
		const sessionIds = owned.map((session) => session.id);
		if (sessionIds.length === 0) return { type: "heartbeat_ack", serverTime: Date.now() };
		await db
			.update(sessions)
			.set({ lastHeartbeatAt: now })
			.where(or(...sessionIds.map((id) => eq(sessions.id, id))));
		for (const sessionId of sessionIds) {
			if (await recomputeSessionState(sessionId)) publish({ type: "session_update", sessionId });
		}
	}
	return { type: "heartbeat_ack", serverTime: Date.now() };
}

function sessionIdFrom(msg: UpstreamMessage): string | undefined {
	return "sessionId" in msg ? msg.sessionId : undefined;
}

async function sessionBelongsToUser(sessionId: string, userId: string): Promise<boolean> {
	const [session] = await db
		.select({ id: sessions.id })
		.from(sessions)
		.where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
		.limit(1);
	return Boolean(session);
}

// --- state derivation ---------------------------------------------------------

/** Derive state from first principles: open approvals > open turn > idle. */
export async function recomputeSessionState(
	sessionId: string,
	activityAt?: Date,
): Promise<boolean> {
	const [session] = await db
		.select({ state: sessions.state })
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	if (!session || session.state === "finished") return false;

	const pending = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(approvals)
		.where(and(eq(approvals.sessionId, sessionId), eq(approvals.status, "pending")));
	const openTurns = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(turns)
		.where(and(eq(turns.sessionId, sessionId), eq(turns.state, "running")));

	let state: "waiting_approval" | "running" | "idle" = "idle";
	if ((pending[0]?.count ?? 0) > 0) state = "waiting_approval";
	else if ((openTurns[0]?.count ?? 0) > 0) state = "running";
	const changed = session.state !== state;
	const updates: { state: typeof state; lastActivityAt?: Date } = { state };
	if (activityAt) updates.lastActivityAt = activityAt;
	await db
		.update(sessions)
		.set(updates)
		.where(eq(sessions.id, sessionId));
	return changed;
}

interface UsageParts {
	input: number;
	cacheRead: number;
	total: number;
}

/** Tolerant read of pi's assistant usage block; shape may drift across pi versions. */
function parseUsage(usage: unknown): UsageParts | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const value = usage as Record<string, unknown>;
	const num = (key: string): number => {
		const part = value[key];
		return typeof part === "number" && Number.isFinite(part) ? part : 0;
	};
	const input = num("input");
	const output = num("output");
	const cacheRead = num("cacheRead");
	const cacheWrite = num("cacheWrite");
	const total = num("totalTokens") || input + output + cacheRead + cacheWrite;
	if (total <= 0) return undefined;
	return { input, cacheRead, total };
}
