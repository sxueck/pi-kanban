import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { GlobalFindingDTO, FindingEvidence } from "@pi-kanban/shared";
import { publish } from "./bus.js";
import { db } from "./db/index.js";
import {
	globalAnalysisStates,
	globalFindings,
	globalInspections,
	globalInspectionLogs,
	projectMemories,
	projects,
	sessions,
} from "./db/schema.js";
import { decryptApiKey, readModelSettings } from "./model-settings.js";
import {
	GLOBAL_AGENT_SYSTEM_PROMPT,
	requestInspectionAgent,
	type ModelInspectionResult,
} from "./model.js";
import { executeGlobalInspectionAgentTool, GLOBAL_AGENT_TOOLS } from "./global-inspection-agent.js";
import { redactForModel, redactText, type Redactable } from "./redact.js";
import { pushMemoryDigest } from "./memory-digest.js";
import { searchTokensFor } from "./search.js";
import { findingRecurrenceKey, INSPECTION_LOCK_TTL_MS, toInspectionConnection } from "./inspector.js";

/**
 * Global consistency audit: a model run over the user's cross-project decision
 * memories (plus on-demand search) that flags direction conflicts and proposes
 * missing product-wide principles. Reuses the project inspection's agent loop,
 * budgets, and redaction pipeline; persists global findings + candidate
 * memories and re-pushes every project digest so live sessions see the result.
 */

/** Confirmed/pinned decision memories per project fed to the model. */
const MEMORIES_PER_PROJECT = 12;
/** Whole-decision ceiling across projects before byte-budget omissions. */
const MAX_PROJECT_DECISIONS = 150;
/** Deterministic ceiling on the serialized model input, like project runs. */
export const MAX_GLOBAL_INPUT_BYTES = 200_000;
const INPUT_WRAPPER_RESERVE = 4_096;
/** Newest global transcripts kept per user. */
export const RETAINED_GLOBAL_INSPECTION_LOGS = 10;
/** Minimum projects with confirmed/pinned memories before an audit makes sense. */
export const MIN_GLOBAL_PROJECTS = 2;
/** Scheduled audits run at most this often, regardless of the sweeper cadence. */
export const GLOBAL_INSPECTION_MIN_INTERVAL_MS = 24 * 60 * 60_000;

export const GLOBAL_INPUT_LIMITS = {
	memoriesPerProject: MEMORIES_PER_PROJECT,
	projectDecisionCeiling: MAX_PROJECT_DECISIONS,
	totalBytes: MAX_GLOBAL_INPUT_BYTES,
} as const;

export interface GlobalInspectionSections {
	globalDecisions: Array<Record<string, unknown>>;
	projects: Array<Record<string, unknown>>;
}

export interface GlobalInspectionOmissions {
	globalDecisions: number;
	projectMemories: number;
}

/** Same whole-item byte-budget discipline as assembleInspectionInput. */
export function assembleGlobalInspectionInput(
	sections: GlobalInspectionSections,
	options: { maxBytes?: number } = {},
) {
	const maxBytes = options.maxBytes ?? MAX_GLOBAL_INPUT_BYTES;
	const budget = maxBytes - INPUT_WRAPPER_RESERVE;
	const base = { audit: "cross-project direction consistency" };
	const baseBytes = Buffer.byteLength(JSON.stringify(base));
	if (baseBytes > budget) {
		throw new Error(`global inspection base sections (${baseBytes} bytes) exceed the ${budget} byte budget`);
	}
	const omissions: GlobalInspectionOmissions = { globalDecisions: 0, projectMemories: 0 };
	const used = { bytes: baseBytes };
	const take = (items: Array<Record<string, unknown>>, section: keyof GlobalInspectionOmissions) => {
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
	// Projects are taken whole first so per-project memory lists never split a
	// project across the budget edge; only whole memories inside a project are
	// omitted, and that count rolls up into projectMemories.
	const projects: Array<Record<string, unknown>> = [];
	let projectMemoryOmissions = 0;
	for (const project of sections.projects.slice(0, MAX_PROJECT_DECISIONS)) {
		const memories = (project.memories as Array<Record<string, unknown>> | undefined) ?? [];
		const before = used.bytes;
		const includedMemories: Array<Record<string, unknown>> = [];
		for (const memory of memories) {
			const cost = Buffer.byteLength(JSON.stringify(memory)) + 1;
			if (used.bytes + cost > budget) {
				projectMemoryOmissions += memories.length - includedMemories.length;
				break;
			}
			used.bytes += cost;
			includedMemories.push(memory);
		}
		if (includedMemories.length === 0 && before === used.bytes) continue;
		projects.push({ ...project, memories: includedMemories });
	}
	if (sections.projects.length > projects.length) {
		projectMemoryOmissions += sections.projects.slice(projects.length)
			.reduce((count, project) => count + (((project.memories as unknown[] | undefined) ?? []).length), 0);
	}
	omissions.projectMemories = projectMemoryOmissions;
	return {
		...base,
		globalDecisions: take(sections.globalDecisions, "globalDecisions"),
		projects,
		context: { limits: GLOBAL_INPUT_LIMITS, omitted: omissions },
	};
}

export async function ensureGlobalAnalysisState(userId: string): Promise<void> {
	await db
		.insert(globalAnalysisStates)
		.values({ userId })
		.onConflictDoNothing({ target: globalAnalysisStates.userId });
}

/** Projects of this user that have at least one confirmed/pinned memory. */
export async function globalEligibleProjectCount(userId: string): Promise<number> {
	const rows = await db
		.select({ projectId: projectMemories.projectId })
		.from(projectMemories)
		.where(and(
			eq(projectMemories.userId, userId),
			eq(projectMemories.scope, "project"),
			isNull(projectMemories.supersededAt),
			inArray(projectMemories.status, ["confirmed", "pinned"]),
		))
		.groupBy(projectMemories.projectId);
	return rows.length;
}

export async function queueGlobalInspection(userId: string, trigger: "manual" | "schedule"): Promise<boolean> {
	const connection = toInspectionConnection(await readModelSettings());
	if (!connection) throw new Error("model inspection is not configured");
	const apiKey = decryptApiKey(connection.apiKeyCipher);
	await ensureGlobalAnalysisState(userId);
	const now = new Date();
	const staleBefore = new Date(now.getTime() - INSPECTION_LOCK_TTL_MS);
	const nextGuard = new Date(now.getTime() + INSPECTION_LOCK_TTL_MS);
	const [claimed] = await db
		.update(globalAnalysisStates)
		.set({ lockedAt: now, updatedAt: now })
		.where(and(
			eq(globalAnalysisStates.userId, userId),
			or(isNull(globalAnalysisStates.lockedAt), lt(globalAnalysisStates.lockedAt, staleBefore)),
		))
		.returning({ userId: globalAnalysisStates.userId });
	if (!claimed) return false;
	let runId: string;
	try {
		const [run] = await db
			.insert(globalInspections)
			.values({ userId, trigger, status: "running" })
			.returning({ id: globalInspections.id });
		runId = run.id;
	} catch (error) {
		await db
			.update(globalAnalysisStates)
			.set({ lockedAt: null, updatedAt: now })
			.where(and(eq(globalAnalysisStates.userId, userId), eq(globalAnalysisStates.lockedAt, now)));
		throw error;
	}
	void executeGlobalInspection(runId, userId, trigger, {
		baseUrl: connection.baseUrl,
		model: connection.model,
		apiKey,
	}, now).catch((error) => {
		console.error("[pi-kanban] global inspection failure handler failed:", error instanceof Error ? error.message : error);
	});
	return true;
}

/** Eligible users, including those who have not yet opened the Consistency view. */
export function globalInspectionEligibleUsersQuery() {
	return db
		.select({
			userId: projectMemories.userId,
			lockedAt: globalAnalysisStates.lockedAt,
			lastInspectionAt: globalAnalysisStates.lastInspectionAt,
		})
		.from(projectMemories)
		.leftJoin(globalAnalysisStates, eq(globalAnalysisStates.userId, projectMemories.userId))
		.where(and(
			eq(projectMemories.scope, "project"),
			isNull(projectMemories.supersededAt),
			inArray(projectMemories.status, ["confirmed", "pinned"]),
		))
		.groupBy(projectMemories.userId, globalAnalysisStates.lockedAt, globalAnalysisStates.lastInspectionAt)
		.having(sql`count(distinct ${projectMemories.projectId}) >= ${MIN_GLOBAL_PROJECTS}`);
}

/** Scheduled sweep: one audit per user per day when the corpus is big enough. */
export async function runDueGlobalInspections(): Promise<void> {
	const settings = await readModelSettings();
	if (!settings?.enabled || !settings.apiKeyCipher) return;
	const rows = await globalInspectionEligibleUsersQuery();
	const now = Date.now();
	for (const row of rows) {
		if (row.lockedAt && now - row.lockedAt.getTime() < INSPECTION_LOCK_TTL_MS) continue;
		if (row.lastInspectionAt && now - row.lastInspectionAt.getTime() < GLOBAL_INSPECTION_MIN_INTERVAL_MS) continue;
		try {
			await queueGlobalInspection(row.userId, "schedule");
		} catch (error) {
			console.error("[pi-kanban] scheduled global inspection failed to start:", error instanceof Error ? error.message : error);
		}
	}
}

async function buildGlobalSections(userId: string): Promise<GlobalInspectionSections> {
	const [globalRows, projectRows] = await Promise.all([
		db.select({
			id: projectMemories.memoryKey,
			kind: projectMemories.kind,
			content: projectMemories.content,
			status: projectMemories.status,
			occurrenceCount: projectMemories.occurrenceCount,
		}).from(projectMemories).where(and(
			eq(projectMemories.userId, userId),
			eq(projectMemories.scope, "global"),
			isNull(projectMemories.supersededAt),
		)).orderBy(desc(projectMemories.occurrenceCount)),
		db.select({
			id: projectMemories.memoryKey,
			projectId: projectMemories.projectId,
			kind: projectMemories.kind,
			content: projectMemories.content,
			status: projectMemories.status,
			occurrenceCount: projectMemories.occurrenceCount,
		}).from(projectMemories).where(and(
			eq(projectMemories.userId, userId),
			eq(projectMemories.scope, "project"),
			isNull(projectMemories.supersededAt),
			inArray(projectMemories.status, ["confirmed", "pinned"]),
		)).orderBy(desc(projectMemories.occurrenceCount), desc(projectMemories.lastSeenAt)),
	]);
	const projectMeta = await db.select({ id: projects.id, name: projects.name, gitRemote: projects.gitRemote }).from(projects).where(isNull(projects.deletedAt));
	const metaById = new Map(projectMeta.map((project) => [project.id, project]));
	const byProject = new Map<number, typeof projectRows>();
	for (const row of projectRows) {
		if (row.projectId == null || !metaById.has(row.projectId)) continue;
		const list = byProject.get(row.projectId) ?? [];
		if (list.length < MEMORIES_PER_PROJECT) list.push(row);
		byProject.set(row.projectId, list);
	}
	return {
		globalDecisions: globalRows.map((row) => ({ ...row, scope: "global" })),
		projects: [...byProject.entries()].map(([projectId, memories]) => {
			const meta = metaById.get(projectId);
			return {
				projectId,
				name: meta?.name ?? `project-${projectId}`,
				gitRemote: meta?.gitRemote ?? undefined,
				memories: memories.map((row) => ({ id: row.id, kind: row.kind, content: row.content, status: row.status, occurrenceCount: row.occurrenceCount })),
			};
		}),
	};
}

async function executeGlobalInspection(
	runId: string,
	userId: string,
	trigger: "manual" | "schedule",
	connection: { baseUrl: string; model: string; apiKey: string },
	claimedAt: Date,
): Promise<void> {
	const logPayloads: unknown[] = [];
	try {
		const sections = await buildGlobalSections(userId);
		const input = toRedactable(assembleGlobalInspectionInput(sections));
		const redactedInput = redactForModel(input);
		let inputRedactions = redactedInput.count;
		const agent = await requestInspectionAgent(connection, redactedInput.value, GLOBAL_AGENT_TOOLS, {
			systemPrompt: GLOBAL_AGENT_SYSTEM_PROMPT,
			executeTool: (call) => executeGlobalInspectionAgentTool(userId, call),
		});
		const redactedSteps = redactForModel(toRedactable(agent.steps));
		logPayloads.push({ mode: "agent", input: redactedInput.value, steps: redactedSteps.value });
		inputRedactions += redactedSteps.count;
		const result = redactGlobalResult(agent.result);
		const responseRedaction = redactText(agent.content);
		const reasoningRedaction = agent.reasoning == null ? undefined : redactText(agent.reasoning);
		await persistGlobalInspectionResult(runId, userId, result.value, inputRedactions + result.count + responseRedaction.count + (reasoningRedaction?.count ?? 0), {
			requestPayload: { runs: logPayloads },
			responseContent: responseRedaction.value,
			reasoningContent: reasoningRedaction?.value,
		}, claimedAt);
	} catch (error) {
		const failedAt = new Date();
		const message = redactText(error instanceof Error ? error.message : String(error)).value.slice(0, 1000);
		if (logPayloads.length > 0) {
			await db.insert(globalInspectionLogs).values({ inspectionId: runId, requestPayload: { runs: logPayloads } })
				.onConflictDoNothing().catch(() => undefined);
			await pruneGlobalInspectionLogs(userId).catch(() => undefined);
		}
		await Promise.all([
			db.update(globalInspections).set({ status: "failed", error: message, finishedAt: failedAt }).where(eq(globalInspections.id, runId)),
			db.update(globalAnalysisStates).set({
				lockedAt: null,
				lastError: message,
				updatedAt: failedAt,
			}).where(and(
				eq(globalAnalysisStates.userId, userId),
				eq(globalAnalysisStates.lockedAt, claimedAt),
			)),
		]);
		publish({ type: "global_update", userId });
	}
}

function redactGlobalResult(result: ModelInspectionResult): { value: ModelInspectionResult; count: number } {
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
			tree: [],
			findings: result.findings.map((finding) => ({ ...finding, summary: redact(finding.summary) ?? "", detail: redact(finding.detail) })),
		},
		count,
	};
}

async function persistGlobalInspectionResult(
	runId: string,
	userId: string,
	result: ModelInspectionResult,
	redactionCount: number,
	log: { requestPayload: unknown; responseContent: string; reasoningContent?: string },
	claimedAt: Date,
): Promise<void> {
	const [activeMemoryRows, existingFindings] = await Promise.all([
		db.select({ memoryKey: projectMemories.memoryKey, scope: projectMemories.scope }).from(projectMemories).where(and(
			eq(projectMemories.userId, userId),
			isNull(projectMemories.supersededAt),
		)),
		db.select({
			id: globalFindings.id,
			kind: globalFindings.kind,
			severity: globalFindings.severity,
			summary: globalFindings.summary,
		}).from(globalFindings).where(eq(globalFindings.userId, userId)),
	]);
	const allowedMemoryKeys = new Set(activeMemoryRows.map((row) => row.memoryKey));
	const sessionRows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId));
	const allowedSessions = new Set(sessionRows.map((row) => row.id));
	const validEvidence = (entry: FindingEvidence) =>
		(entry.memoryId !== undefined && allowedMemoryKeys.has(entry.memoryId))
		|| (entry.sessionId !== undefined && allowedSessions.has(entry.sessionId));
	const now = new Date();
	await db.transaction(async (tx) => {
		const [owner] = await tx.select({ userId: globalAnalysisStates.userId }).from(globalAnalysisStates)
			.where(and(eq(globalAnalysisStates.userId, userId), eq(globalAnalysisStates.lockedAt, claimedAt)))
			.for("update").limit(1);
		if (!owner) throw new Error("global inspection claim expired; result discarded");
		// Global principle proposals land as candidates — the user confirms
		// before they are injected into any project digest.
		for (const memory of result.memories) {
			const evidence = memory.evidence.filter(validEvidence);
			if (evidence.length === 0) continue;
			await tx.insert(projectMemories).values({
				memoryKey: randomUUID(),
				userId,
				projectId: null,
				scope: "global",
				version: 1,
				kind: memory.kind,
				content: memory.content,
				searchTokens: searchTokensFor(memory.content),
				status: "candidate",
				evidence,
				sourceInspectionId: null,
				lastSeenInspectionId: null,
			});
		}
		const findingIndex = new Map(existingFindings.map((row) => [findingRecurrenceKey(row), row]));
		for (const finding of result.findings) {
			if (finding.kind !== "direction_conflict") continue;
			const evidence = finding.evidence.filter(validEvidence);
			if (evidence.length === 0) continue;
			const existing = findingIndex.get(findingRecurrenceKey(finding));
			if (existing) {
				await tx.update(globalFindings).set({
					occurrenceCount: sql`${globalFindings.occurrenceCount} + 1`,
					lastSeenAt: now,
					...(finding.detail ? { detail: finding.detail, severity: finding.severity } : {}),
				}).where(eq(globalFindings.id, existing.id));
				continue;
			}
			await tx.insert(globalFindings).values({
				userId,
				kind: finding.kind,
				severity: finding.severity,
				summary: finding.summary,
				detail: finding.detail,
				evidence,
			});
		}
		await tx.update(globalAnalysisStates).set({
			lockedAt: null,
			lastInspectionAt: now,
			lastError: null,
			updatedAt: now,
		}).where(and(
			eq(globalAnalysisStates.userId, userId),
			eq(globalAnalysisStates.lockedAt, claimedAt),
		));
		await tx.update(globalInspections).set({ status: "done", redactionCount, finishedAt: now }).where(eq(globalInspections.id, runId));
		await tx.insert(globalInspectionLogs).values({
			inspectionId: runId,
			requestPayload: log.requestPayload,
			responseContent: log.responseContent,
			reasoningContent: log.reasoningContent,
		}).onConflictDoNothing({ target: globalInspectionLogs.inspectionId });
	});
	await pruneGlobalInspectionLogs(userId);
	publish({ type: "global_update", userId });
	// Global memories change every project's digest: refresh all live projects.
	const projectRows = await db
		.selectDistinct({ projectId: sessions.projectId })
		.from(sessions)
		.where(and(eq(sessions.userId, userId), sql`${sessions.projectId} is not null`, sql`${sessions.state} <> 'finished'`));
	for (const row of projectRows) {
		if (row.projectId != null) void pushMemoryDigest(userId, row.projectId);
	}
}

/** Keeps only the newest RETAINED_GLOBAL_INSPECTION_LOGS transcripts per user. */
async function pruneGlobalInspectionLogs(userId: string): Promise<void> {
	await db.execute(sql`
		DELETE FROM global_inspection_logs
		WHERE inspection_id IN (
			SELECT l.inspection_id
			FROM global_inspection_logs l
			JOIN global_inspections i ON i.id = l.inspection_id
			WHERE i.user_id = ${userId}
			ORDER BY i.started_at DESC
			OFFSET ${RETAINED_GLOBAL_INSPECTION_LOGS}
		)
	`);
}

export function toGlobalFindingDto(row: typeof globalFindings.$inferSelect): GlobalFindingDTO {
	return {
		id: row.id,
		kind: row.kind as GlobalFindingDTO["kind"],
		severity: row.severity as GlobalFindingDTO["severity"],
		summary: row.summary,
		detail: row.detail ?? undefined,
		evidence: (Array.isArray(row.evidence) ? row.evidence : []).flatMap((entry): FindingEvidence[] => {
			if (!entry || typeof entry !== "object") return [];
			const item = entry as Record<string, unknown>;
			const out: FindingEvidence = {};
			if (typeof item.sessionId === "string" && item.sessionId) out.sessionId = item.sessionId;
			if (typeof item.turnPosition === "number" && Number.isInteger(item.turnPosition)) out.turnPosition = item.turnPosition;
			if (typeof item.memoryId === "string" && item.memoryId) out.memoryId = item.memoryId;
			return Object.keys(out).length > 0 ? [out] : [];
		}),
		resolution: row.resolution as GlobalFindingDTO["resolution"],
		resolvedNote: row.resolvedNote ?? undefined,
		occurrenceCount: row.occurrenceCount,
		createdAt: row.createdAt.getTime(),
		lastSeenAt: row.lastSeenAt.getTime(),
	};
}

function toRedactable(value: unknown): Redactable {
	try {
		return JSON.parse(JSON.stringify(value)) as Redactable;
	} catch {
		throw new Error("global inspection input could not be serialized");
	}
}
