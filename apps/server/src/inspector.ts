import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";
import type {
	ProjectMemoryDTO,
	ProjectMemoryKind,
	ProjectMemoryStatus,
	ProjectTreeNodeDTO,
} from "@pi-kanban/shared";
import { publish } from "./bus.js";
import { db } from "./db/index.js";
import {
	messages,
	modelSettings,
	projectAnalysisStates,
	projectInspections,
	projectMemories,
	projects,
	projectSnapshots,
	sessions,
	toolCalls,
	turns,
} from "./db/schema.js";
import { decryptApiKey, readModelSettings } from "./model-settings.js";
import { FULL_INSPECTION_TIMEOUT_MS, requestInspection, type ModelInspectionResult } from "./model.js";
import { buildStructureTree, mergeProjectTree } from "./project-tree.js";
import { redactForModel, redactText, type Redactable } from "./redact.js";

export const INSPECTION_LOCK_TTL_MS = 10 * 60_000;
const SESSION_LIMIT = 12;
const MESSAGE_LIMIT = 400;
const TOOL_LIMIT = 100;
const MEMORY_LIMIT = 200;
/** Deterministic ceiling on the serialized model input (~100k tokens). */
export const MAX_INPUT_BYTES = 400_000;
/** Reserved for the wrapper keys/braces outside the budgeted sections. */
const INPUT_WRAPPER_RESERVE = 4_096;

/** Per-section caps, surfaced to the model so omissions are never silent. */
export const INPUT_LIMITS = {
	sessions: SESSION_LIMIT,
	messages: MESSAGE_LIMIT,
	failedTools: TOOL_LIMIT,
	knownMemories: MEMORY_LIMIT,
	totalBytes: MAX_INPUT_BYTES,
} as const;

export interface InspectionInputSections {
	project: { name: string; gitRemote?: string | null };
	snapshot: { fileCount: number; git: unknown; diagnostics: unknown; truncated: boolean } | null;
	structureTree: ProjectTreeNodeDTO[];
	sessions: Array<Record<string, unknown>>;
	messages: Array<Record<string, unknown>>;
	failedTools: Array<Record<string, unknown>>;
	knownMemories: Array<Record<string, unknown>>;
}

export interface InspectionOmissions {
	sessions: number;
	messages: number;
	failedTools: number;
	knownMemories: number;
}

/**
 * Assembles the model payload under a deterministic byte budget: sections are
 * filled in a fixed priority order (project, snapshot, structureTree, then
 * sessions, messages, failedTools, knownMemories), whole items at a time.
 * Items that no longer fit are counted in `context.omitted` — the serialized
 * JSON itself is never string-truncated, and if the base sections alone exceed
 * the budget the build fails loudly instead of corrupting the payload.
 */
export function assembleInspectionInput(
	sections: InspectionInputSections,
	options: { maxBytes?: number } = {},
) {
	const maxBytes = options.maxBytes ?? MAX_INPUT_BYTES;
	const budget = maxBytes - INPUT_WRAPPER_RESERVE;
	const base: Record<string, unknown> = {
		project: sections.project,
		snapshot: sections.snapshot,
		structureTree: sections.structureTree.map((node) => ({
			id: node.id,
			parentId: node.parentId ?? "project",
			kind: node.kind,
			label: node.label,
			...(node.detail === undefined ? {} : { detail: node.detail }),
		})),
	};
	const baseBytes = Buffer.byteLength(JSON.stringify(base));
	if (baseBytes > budget) {
		throw new Error(
			`inspection input base sections (${baseBytes} bytes) exceed the ${budget} byte budget; refusing to truncate serialized JSON`,
		);
	}
	const omissions: InspectionOmissions = { sessions: 0, messages: 0, failedTools: 0, knownMemories: 0 };
	const used = { bytes: baseBytes };
	const take = (items: Array<Record<string, unknown>>, section: keyof InspectionOmissions) => {
		const included: Array<Record<string, unknown>> = [];
		for (const item of items) {
			const cost = Buffer.byteLength(JSON.stringify(item)) + 1;
			if (used.bytes + cost > budget) {
				omissions[section] = items.length - included.length;
				break;
			}
			used.bytes += cost;
			included.push(item);
		}
		return included;
	};
	return {
		...base,
		sessions: take(sections.sessions, "sessions"),
		messages: take(sections.messages, "messages"),
		failedTools: take(sections.failedTools, "failedTools"),
		knownMemories: take(sections.knownMemories, "knownMemories"),
		context: { limits: INPUT_LIMITS, omitted: omissions },
	};
}

export async function ensureProjectAnalysisState(userId: string, projectId: number): Promise<void> {
	await db
		.insert(projectAnalysisStates)
		.values({ userId, projectId, nextInspectionAt: new Date() })
		.onConflictDoNothing({ target: [projectAnalysisStates.userId, projectAnalysisStates.projectId] });
}

/**
 * Manual inspection only needs a complete connection; the scheduled-inspection
 * toggle (enabled) is enforced by runDueInspections, not here.
 */
export function toInspectionConnection(
	settings: typeof modelSettings.$inferSelect | undefined,
): { baseUrl: string; model: string; apiKeyCipher: string; intervalMinutes: number } | null {
	if (!settings?.baseUrl || !settings.model || !settings.apiKeyCipher) return null;
	return {
		baseUrl: settings.baseUrl,
		model: settings.model,
		apiKeyCipher: settings.apiKeyCipher,
		intervalMinutes: settings.inspectionIntervalMinutes,
	};
}

export async function queueProjectInspection(
	userId: string,
	projectId: number,
	trigger: "manual" | "schedule",
): Promise<boolean> {
	const connection = toInspectionConnection(await readModelSettings());
	if (!connection) throw new Error("model inspection is not configured");
	const apiKey = decryptApiKey(connection.apiKeyCipher);
	await ensureProjectAnalysisState(userId, projectId);
	const now = new Date();
	const staleBefore = new Date(now.getTime() - INSPECTION_LOCK_TTL_MS);
	// The claim-time nextInspectionAt is only a crash guard (a stuck lock stops
	// looking due after one TTL); success and failure both reschedule using the
	// configured interval below.
	const nextInspectionAt = new Date(now.getTime() + INSPECTION_LOCK_TTL_MS);
	const [claimed] = await db
		.update(projectAnalysisStates)
		.set({ lockedAt: now, nextInspectionAt, updatedAt: now })
		.where(and(
			eq(projectAnalysisStates.userId, userId),
			eq(projectAnalysisStates.projectId, projectId),
			or(isNull(projectAnalysisStates.lockedAt), lt(projectAnalysisStates.lockedAt, staleBefore)),
		))
		.returning({ id: projectAnalysisStates.id });
	if (!claimed) return false;
	let runId: string;
	try {
		const [run] = await db
			.insert(projectInspections)
			.values({ userId, projectId, trigger, status: "running" })
			.returning({ id: projectInspections.id });
		runId = run.id;
	} catch (error) {
		// The run row could not be created: release the claim we just took
		// (guarded by our own lockedAt) instead of parking the project for a
		// full lock TTL, and reschedule at the configured interval.
		await db
			.update(projectAnalysisStates)
			.set({
				lockedAt: null,
				nextInspectionAt: new Date(now.getTime() + connection.intervalMinutes * 60_000),
				updatedAt: now,
			})
			.where(and(
				eq(projectAnalysisStates.userId, userId),
				eq(projectAnalysisStates.projectId, projectId),
				eq(projectAnalysisStates.lockedAt, now),
			));
		throw error;
	}
	void executeInspection(runId, userId, projectId, connection.intervalMinutes, {
		baseUrl: connection.baseUrl,
		model: connection.model,
		apiKey,
	}, now).catch((error) => {
		console.error("[pi-kanban] project inspection failure handler failed:", error instanceof Error ? error.message : error);
	});
	return true;
}

export async function runDueInspections(): Promise<void> {
	const now = new Date();
	const staleBefore = new Date(now.getTime() - INSPECTION_LOCK_TTL_MS);
	await db.update(projectInspections).set({ status: "failed", error: "interrupted", finishedAt: now }).where(and(
		eq(projectInspections.status, "running"),
		lt(projectInspections.startedAt, staleBefore),
	));
	const settings = await readModelSettings();
	if (!settings?.enabled || !settings.apiKeyCipher) return;
	const due = await db
		.select({ userId: projectAnalysisStates.userId, projectId: projectAnalysisStates.projectId })
		.from(projectAnalysisStates)
		.where(and(
			lte(projectAnalysisStates.nextInspectionAt, now),
			or(isNull(projectAnalysisStates.lockedAt), lt(projectAnalysisStates.lockedAt, staleBefore)),
		))
		.limit(3);
	for (const state of due) {
		try {
			await queueProjectInspection(state.userId, state.projectId, "schedule");
		} catch (error) {
			console.error("[pi-kanban] scheduled project inspection failed to start:", error instanceof Error ? error.message : error);
		}
	}
}

async function executeInspection(
	runId: string,
	userId: string,
	projectId: number,
	intervalMinutes: number,
	connection: { baseUrl: string; model: string; apiKey: string },
	claimedAt: Date,
): Promise<void> {
	try {
		const input = await buildInspectionInput(userId, projectId);
		const redactedInput = redactForModel(input);
		const rawResult = await requestInspection(connection, redactedInput.value, {
			timeoutMs: FULL_INSPECTION_TIMEOUT_MS,
			purpose: "model inspection",
		});
		const redactedResult = redactInspectionResult(rawResult);
		await persistInspectionResult(runId, userId, projectId, intervalMinutes, redactedResult.value, redactedInput.count + redactedResult.count, claimedAt);
	} catch (error) {
		const failedAt = new Date();
		const message = redactText(error instanceof Error ? error.message : String(error)).value.slice(0, 1000);
		await Promise.all([
			db.update(projectInspections).set({ status: "failed", error: message, finishedAt: failedAt }).where(eq(projectInspections.id, runId)),
			// Release the lock and reschedule the retry at the configured
			// interval (never the lock TTL). The lockedAt guard keeps a stale
			// run from clearing a newer claim that took over after this lock expired.
			db.update(projectAnalysisStates).set({
				lockedAt: null,
				lastError: message,
				nextInspectionAt: new Date(failedAt.getTime() + intervalMinutes * 60_000),
				updatedAt: failedAt,
			}).where(and(
				eq(projectAnalysisStates.userId, userId),
				eq(projectAnalysisStates.projectId, projectId),
				eq(projectAnalysisStates.lockedAt, claimedAt),
			)),
		]);
		publish({ type: "project_update", userId, projectId });
	}
}

async function buildInspectionInput(userId: string, projectId: number): Promise<Redactable> {
	const [projectRows, snapshotRows, sessionRows, memoryRows] = await Promise.all([
		db.select({ name: projects.name, gitRemote: projects.gitRemote }).from(projects).where(eq(projects.id, projectId)).limit(1),
		db.select().from(projectSnapshots).where(and(eq(projectSnapshots.userId, userId), eq(projectSnapshots.projectId, projectId))).orderBy(desc(projectSnapshots.createdAt)).limit(1),
		db.select({ id: sessions.id, title: sessions.title, branch: sessions.branch, state: sessions.state, lastActivityAt: sessions.lastActivityAt }).from(sessions).where(and(eq(sessions.userId, userId), eq(sessions.projectId, projectId))).orderBy(desc(sessions.lastActivityAt)).limit(SESSION_LIMIT),
		db.select({ id: projectMemories.memoryKey, kind: projectMemories.kind, content: projectMemories.content, status: projectMemories.status }).from(projectMemories).where(and(eq(projectMemories.userId, userId), eq(projectMemories.projectId, projectId), isNull(projectMemories.supersededAt))).orderBy(desc(projectMemories.createdAt), desc(projectMemories.id)).limit(MEMORY_LIMIT),
	]);
	if (!projectRows[0]) throw new Error("project not found");
	const sessionIds = sessionRows.map((session) => session.id);
	const [messageRows, failedTools] = sessionIds.length > 0
		? await Promise.all([
			db.select({ sessionId: messages.sessionId, turnPosition: messages.turnPosition, role: messages.role, excerpt: messages.excerpt }).from(messages).where(inArray(messages.sessionId, sessionIds)).orderBy(desc(messages.createdAt), desc(messages.id)).limit(MESSAGE_LIMIT),
			db.select({ sessionId: toolCalls.sessionId, toolName: toolCalls.toolName, result: toolCalls.resultExcerpt }).from(toolCalls).where(and(inArray(toolCalls.sessionId, sessionIds), eq(toolCalls.isError, true))).orderBy(desc(toolCalls.startedAt), desc(toolCalls.id)).limit(TOOL_LIMIT),
		])
		: [[], []];
	const snapshot = snapshotRows[0];
	const files = asSnapshotFiles(snapshot?.files);
	// The raw file manifest (up to 2000 paths) is not sent; the bounded
	// structure tree carries the same layout plus the stable node ids the
	// model must reference in tree parentId fields.
	const structureTree = buildStructureTree(files, projectRows[0].name);
	return toRedactable(assembleInspectionInput({
		project: projectRows[0],
		snapshot: snapshot ? {
			fileCount: files.length,
			git: snapshot.git,
			diagnostics: snapshot.diagnostics,
			truncated: snapshot.truncated,
		} : null,
		structureTree,
		sessions: sessionRows.map((session) => ({ ...session, lastActivityAt: session.lastActivityAt.toISOString() })),
		messages: messageRows,
		failedTools,
		knownMemories: memoryRows,
	}));
}

async function persistInspectionResult(
	runId: string,
	userId: string,
	projectId: number,
	intervalMinutes: number,
	result: ModelInspectionResult,
	redactionCount: number,
	claimedAt: Date,
): Promise<void> {
	const [projectRow, snapshotRow, existingRows] = await Promise.all([
		db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1),
		db.select({ files: projectSnapshots.files }).from(projectSnapshots).where(and(eq(projectSnapshots.userId, userId), eq(projectSnapshots.projectId, projectId))).orderBy(desc(projectSnapshots.createdAt)).limit(1),
		db.select({ content: projectMemories.content }).from(projectMemories).where(and(eq(projectMemories.userId, userId), eq(projectMemories.projectId, projectId), isNull(projectMemories.supersededAt))),
	]);
	const sessionRows = await db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.userId, userId), eq(sessions.projectId, projectId)));
	const allowedSessions = new Set(sessionRows.map((row) => row.id));
	const turnRows = sessionRows.length > 0
		? await db.select({ sessionId: turns.sessionId, position: turns.position }).from(turns).where(inArray(turns.sessionId, sessionRows.map((row) => row.id)))
		: [];
	const allowedTurns = new Set(turnRows.map((row) => `${row.sessionId}:${row.position}`));
	const validEvidence = (entry: { sessionId: string; turnPosition?: number }) =>
		allowedSessions.has(entry.sessionId) && (entry.turnPosition === undefined || allowedTurns.has(`${entry.sessionId}:${entry.turnPosition}`));
	const existing = new Set(existingRows.map((row) => normalizeMemory(row.content)));
	const candidates = result.memories.filter((memory) => !existing.has(normalizeMemory(memory.content)));
	const files = asSnapshotFiles(snapshotRow[0]?.files);
	const structure = buildStructureTree(files, projectRow[0]?.name ?? "Project");
	const tree = mergeProjectTree(structure, result.tree.filter((node) => !node.sessionId || validEvidence({ sessionId: node.sessionId, turnPosition: node.turnPosition })));
	const now = new Date();
	await db.transaction(async (tx) => {
		// Fence all result writes, not only the unlock, against a replaced claim.
		const [owner] = await tx.select({ id: projectAnalysisStates.id }).from(projectAnalysisStates)
			.where(and(eq(projectAnalysisStates.userId, userId), eq(projectAnalysisStates.projectId, projectId), eq(projectAnalysisStates.lockedAt, claimedAt)))
			.for("update").limit(1);
		if (!owner) throw new Error("inspection claim expired; result discarded");
		if (candidates.length > 0) {
			await tx.insert(projectMemories).values(candidates.map((memory) => ({
				memoryKey: randomUUID(),
				userId,
				projectId,
				version: 1,
				kind: memory.kind,
				content: memory.content,
				status: "candidate",
				evidence: memory.evidence.filter(validEvidence),
				sourceInspectionId: runId,
			})));
		}
		// Guarded by the claim timestamp: if this run's lock expired and a newer
		// run claimed the project, this completion must not overwrite the new
		// claim's schedule or clear its lock.
		await tx.update(projectAnalysisStates).set({
			latestTree: tree,
			lockedAt: null,
			lastInspectionAt: now,
			nextInspectionAt: new Date(now.getTime() + intervalMinutes * 60_000),
			lastError: null,
			updatedAt: now,
		}).where(and(
			eq(projectAnalysisStates.userId, userId),
			eq(projectAnalysisStates.projectId, projectId),
			eq(projectAnalysisStates.lockedAt, claimedAt),
		));
		await tx.update(projectInspections).set({ status: "done", redactionCount, finishedAt: now }).where(eq(projectInspections.id, runId));
	});
	publish({ type: "project_update", userId, projectId });
}

export function toMemoryDto(row: typeof projectMemories.$inferSelect): ProjectMemoryDTO {
	return {
		id: row.memoryKey,
		version: row.version,
		kind: row.kind as ProjectMemoryKind,
		content: row.content,
		status: row.status as ProjectMemoryStatus,
		evidence: asEvidence(row.evidence),
		createdAt: row.createdAt.getTime(),
	};
}

export function redactInspectionResult(result: ModelInspectionResult): { value: ModelInspectionResult; count: number } {
	let count = 0;
	const redact = (value: string | undefined) => {
		if (value === undefined) return undefined;
		const redacted = redactText(value);
		count += redacted.count;
		return redacted.value;
	};
	return {
		value: {
			memories: result.memories.map((memory) => ({ ...memory, content: redact(memory.content) ?? "" })),
			tree: result.tree.map((node) => ({ ...node, label: redact(node.label) ?? "", detail: redact(node.detail) })),
		},
		count,
	};
}

function asSnapshotFiles(value: unknown): Array<{ path: string; size?: number }> {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const item = entry as Record<string, unknown>;
		if (typeof item.path !== "string") return [];
		return [{ path: item.path, size: typeof item.size === "number" ? item.size : undefined }];
	});
}

function asEvidence(value: unknown): Array<{ sessionId: string; turnPosition?: number }> {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const item = entry as Record<string, unknown>;
		return typeof item.sessionId === "string"
			? [{ sessionId: item.sessionId, turnPosition: typeof item.turnPosition === "number" ? item.turnPosition : undefined }]
			: [];
	});
}

function normalizeMemory(value: string): string {
	return value.trim().toLocaleLowerCase();
}

function toRedactable(value: Record<string, unknown>): Redactable {
	try {
		return JSON.parse(JSON.stringify(value)) as Redactable;
	} catch {
		throw new Error("inspection input could not be serialized");
	}
}
