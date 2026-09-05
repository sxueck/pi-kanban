import { and, eq, lt, sql } from "drizzle-orm";
import type { ApprovalDecisionMessage } from "@pi-kanban/shared";
import { db } from "./db/index.js";
import { approvals, sessions } from "./db/schema.js";
import { publish } from "./bus.js";
import { recomputeSessionState } from "./ingest.js";

/** Pending approvals older than this are marked expired (plugin already gave up). */
export const APPROVAL_TTL_MS = Number(process.env.APPROVAL_TTL_MS ?? 30 * 60_000);

export async function decideApproval(
	id: string,
	decision: "approved" | "denied",
	decidedBy: string | undefined,
	note: string | undefined,
	userId: string,
	sendToMachine: (userId: string, machineId: string, msg: ApprovalDecisionMessage) => boolean = () => false,
): Promise<{ ok: boolean; error?: string }> {
	const [row] = await db
		.update(approvals)
		.set({ status: decision, decidedAt: new Date(), decidedBy, note })
		.where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
		.returning();
	if (!row) return { ok: false, error: "approval not found or already decided" };

	// Deliver to the blocked plugin; if disconnected, the plugin's own timeout
	// policy applies (it will also see the decision on reconnect-free retry).
	sendToMachine(userId, row.machineId, {
		type: "approval_decision",
		approvalId: row.id,
		decision,
		decidedBy,
		note,
	});
	await recomputeSessionState(row.sessionId, new Date());
	publish({ type: "approval_update", approvalId: row.id, sessionId: row.sessionId });
	return { ok: true };
}

/** Periodic sweep: expire stale pending approvals. */
export async function sweepExpiredApprovals(): Promise<number> {
	const cutoff = new Date(Date.now() - APPROVAL_TTL_MS);
	const expired = await db
		.update(approvals)
		.set({ status: "expired", decidedAt: new Date() })
		.where(and(eq(approvals.status, "pending"), lt(approvals.requestedAt, cutoff)))
		.returning({ id: approvals.id, sessionId: approvals.sessionId });
	for (const row of expired) {
		await recomputeSessionState(row.sessionId, new Date());
		publish({ type: "approval_update", approvalId: row.id, sessionId: row.sessionId });
	}
	return expired.length;
}

/** Periodic sweep: mark silent live sessions offline. */
export async function sweepOfflineSessions(): Promise<number> {
	const offlineAfterMs = Number(process.env.HEARTBEAT_OFFLINE_SEC ?? 90) * 1000;
	const cutoff = new Date(Date.now() - offlineAfterMs);
	const stale = await db
		.update(sessions)
		.set({ state: "offline" })
		.where(
			and(
				sql`${sessions.state} in ('running', 'waiting_approval', 'idle')`,
				lt(sessions.lastHeartbeatAt, cutoff),
			),
		)
		.returning({ id: sessions.id });
	for (const row of stale) {
		publish({ type: "session_update", sessionId: row.id });
	}
	return stale.length;
}
