import { createHash } from "node:crypto";
import { and, eq, isNull, ne } from "drizzle-orm";
import type {
	MemoryDigestEntry,
	MemoryDigestFinding,
	MemoryDigestMessage,
	ProjectMemoryKind,
	ProjectMemoryStatus,
	SessionFindingKind,
	SessionFindingSeverity,
} from "@pi-kanban/shared";
import { truncate } from "@pi-kanban/shared";
import { db } from "./db/index.js";
import { projectFindings, projectMemories, projects, sessions } from "./db/schema.js";
import { sendToMachine } from "./ws.js";

export const DIGEST_MEMORY_LIMIT = 24;
export const DIGEST_FINDING_LIMIT = 8;
const DIGEST_MEMORY_CHARS = 300;
const DIGEST_FINDING_CHARS = 200;
/**
 * Deterministic ceiling on the serialized digest delivered to plugins. Items
 * are dropped whole in reverse priority order; the JSON is never cut mid-item.
 */
export const MAX_DIGEST_BYTES = 8_000;

const MEMORY_STATUS_RANK: Partial<Record<ProjectMemoryStatus, number>> = { pinned: 0, confirmed: 1 };
const UNRANKED = 99;
const FINDING_SEVERITY_RANK: Partial<Record<SessionFindingSeverity, number>> = { error: 0, warning: 1, info: 2 };

export interface DigestMemoryRow {
	kind: string;
	content: string;
	status: string;
	occurrenceCount: number;
	lastSeenAt: Date | number;
}

export interface DigestFindingRow {
	kind: string;
	severity: string;
	summary: string;
	occurrenceCount: number;
	lastSeenAt: Date | number;
}

/**
 * Orders, caps, and hashes the digest payload. Pure so tests can run without a
 * DB: pinned before confirmed, then by recurrence and recency; findings by
 * severity then recency. Items past a cap or the byte budget are dropped whole.
 * The revision hashes only the content, so unchanged projects keep one revision.
 */
export function buildDigestPayload(
	projectName: string,
	memoryRows: DigestMemoryRow[],
	findingRows: DigestFindingRow[],
	now = Date.now(),
): Omit<MemoryDigestMessage, "type" | "projectId"> {
	const memories: MemoryDigestEntry[] = memoryRows
		.filter((row) => MEMORY_STATUS_RANK[row.status as ProjectMemoryStatus] !== undefined)
		.sort((a, b) =>
			(MEMORY_STATUS_RANK[a.status as ProjectMemoryStatus] ?? UNRANKED) - (MEMORY_STATUS_RANK[b.status as ProjectMemoryStatus] ?? UNRANKED)
			|| b.occurrenceCount - a.occurrenceCount
			|| toMs(b.lastSeenAt) - toMs(a.lastSeenAt),
		)
		.slice(0, DIGEST_MEMORY_LIMIT)
		.map((row) => ({
			kind: row.kind as ProjectMemoryKind,
			content: truncate(row.content, DIGEST_MEMORY_CHARS),
			status: row.status as ProjectMemoryStatus,
			occurrenceCount: row.occurrenceCount,
			lastSeenAt: toMs(row.lastSeenAt),
		}));
	const findings: MemoryDigestFinding[] = findingRows
		.sort((a, b) =>
			(FINDING_SEVERITY_RANK[a.severity as SessionFindingSeverity] ?? 3) - (FINDING_SEVERITY_RANK[b.severity as SessionFindingSeverity] ?? 3)
			|| toMs(b.lastSeenAt) - toMs(a.lastSeenAt),
		)
		.slice(0, DIGEST_FINDING_LIMIT)
		.map((row) => ({
			kind: row.kind as SessionFindingKind,
			severity: row.severity as SessionFindingSeverity,
			summary: truncate(row.summary, DIGEST_FINDING_CHARS),
			occurrenceCount: row.occurrenceCount,
			lastSeenAt: toMs(row.lastSeenAt),
		}));
	const budgeted = dropPastByteBudget(memories, findings);
	return {
		projectName,
		revision: digestRevision(projectName, budgeted.memories, budgeted.findings),
		generatedAt: now,
		...budgeted,
	};
}

function toMs(value: Date | number): number {
	return typeof value === "number" ? value : value.getTime();
}

/** Drops trailing items once the serialized digest exceeds MAX_DIGEST_BYTES. */
function dropPastByteBudget(memories: MemoryDigestEntry[], findings: MemoryDigestFinding[]): { memories: MemoryDigestEntry[]; findings: MemoryDigestFinding[] } {
	let size = wrapperBytes();
	const keepMemories: MemoryDigestEntry[] = [];
	for (const memory of memories) {
		const cost = Buffer.byteLength(JSON.stringify(memory)) + 1;
		if (size + cost > MAX_DIGEST_BYTES) break;
		size += cost;
		keepMemories.push(memory);
	}
	const keepFindings: MemoryDigestFinding[] = [];
	for (const finding of findings) {
		const cost = Buffer.byteLength(JSON.stringify(finding)) + 1;
		if (size + cost > MAX_DIGEST_BYTES) break;
		size += cost;
		keepFindings.push(finding);
	}
	return { memories: keepMemories, findings: keepFindings };
}

/** Bytes of the envelope around the two arrays (empty arrays serialized). */
function wrapperBytes(): number {
	return Buffer.byteLength(JSON.stringify({ projectName: "", revision: "", generatedAt: 0, memories: [], findings: [] }));
}

function digestRevision(projectName: string, memories: MemoryDigestEntry[], findings: MemoryDigestFinding[]): string {
	return createHash("sha256").update(JSON.stringify({ projectName, memories, findings })).digest("hex").slice(0, 12);
}

/** Builds the digest for one project; null when the project does not exist. */
export async function buildMemoryDigest(userId: string, projectId: number, sessionId?: string): Promise<MemoryDigestMessage | null> {
	const [project] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1);
	if (!project) return null;
	const [memoryRows, findingRows] = await Promise.all([
		db.select({
			kind: projectMemories.kind,
			content: projectMemories.content,
			status: projectMemories.status,
			occurrenceCount: projectMemories.occurrenceCount,
			lastSeenAt: projectMemories.lastSeenAt,
		}).from(projectMemories).where(and(
			eq(projectMemories.userId, userId),
			eq(projectMemories.projectId, projectId),
			isNull(projectMemories.supersededAt),
		)),
		db.select({
			kind: projectFindings.kind,
			severity: projectFindings.severity,
			summary: projectFindings.summary,
			occurrenceCount: projectFindings.occurrenceCount,
			lastSeenAt: projectFindings.lastSeenAt,
		}).from(projectFindings).where(and(eq(projectFindings.userId, userId), eq(projectFindings.projectId, projectId))),
	]);
	return {
		type: "memory_digest",
		projectId,
		sessionId,
		...buildDigestPayload(project.name, memoryRows, findingRows),
	};
}

/**
 * Best-effort push to every machine holding a live (not finished) session in
 * the project. Disconnected machines miss the push; their next session_start
 * re-fetches, so this never retries.
 */
export async function pushMemoryDigest(userId: string, projectId: number): Promise<void> {
	try {
		const machines = await db
			.selectDistinct({ machineId: sessions.machineId })
			.from(sessions)
			.where(and(eq(sessions.userId, userId), eq(sessions.projectId, projectId), ne(sessions.state, "finished")));
		if (machines.length === 0) return;
		const digest = await buildMemoryDigest(userId, projectId);
		if (!digest) return;
		for (const { machineId } of machines) sendToMachine(userId, machineId, digest);
	} catch (error) {
		console.error("[pi-kanban] memory digest push failed:", error instanceof Error ? error.message : error);
	}
}
