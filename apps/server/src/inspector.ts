import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type {
	InspectionSchedule,
	ProjectMemoryDTO,
	ProjectMemoryKind,
	ProjectMemoryStatus,
	ProjectTreeNodeDTO,
	SessionFindingDTO,
	SessionFindingKind,
	SessionFindingSeverity,
} from "@pi-kanban/shared";
import { computeNextInspectionAt } from "@pi-kanban/shared";
import { publish } from "./bus.js";
import { db } from "./db/index.js";
import {
	approvals,
	messages,
	modelSettings,
	projectAnalysisStates,
	projectFindings,
	projectInspections,
	projectInspectionLogs,
	projectMemories,
	projects,
	projectSnapshots,
	sessions,
	todoLists,
	toolCalls,
	turns,
} from "./db/schema.js";
import { decryptApiKey, readModelSettings, toInspectionSchedule } from "./model-settings.js";
import { recordInspectionDelta, recordInspectionStage } from "./inspection-live.js";
import { FULL_INSPECTION_TIMEOUT_MS, MAX_AGENT_ROUNDS, requestInspectionAgent, requestInspectionStreaming, ToolCapabilityError, type ModelInspectionResult, type ModelMemoryCandidate } from "./model.js";
import { executeInspectionAgentTool, INSPECTION_AGENT_TOOLS } from "./inspection-agent.js";
import { buildStructureTree, mergeProjectTree } from "./project-tree.js";
import { redactForModel, redactText, type Redactable } from "./redact.js";

export const MAX_INSPECTION_BATCHES = 4;
const SESSIONS_PER_INSPECTION_BATCH = 3;
/**
 * A run may use six sequential ten-minute model requests. Leave an extra
 * request of slack so a live claim cannot be reclaimed while it is completing.
 */
export const INSPECTION_LOCK_TTL_MS = (MAX_AGENT_ROUNDS + 1) * FULL_INSPECTION_TIMEOUT_MS;
/** Active SSE streams renew their claim at this cadence, not once per token. */
const INSPECTION_LOCK_HEARTBEAT_MS = 60_000;
/** Newest full transcripts kept per project; older runs keep only their metadata row. */
export const RETAINED_INSPECTION_LOGS = 10;
/** Session findings kept per project; older or one-off findings are pruned by lastSeenAt. */
export const RETAINED_PROJECT_FINDINGS = 50;
/** Evidence rows kept per memory row when merging across consolidations. */
const MERGED_EVIDENCE_LIMIT = 16;
/** Empty UUID rows are retained briefly so a newly opened live session can report its first turn. */
export const EMPTY_SESSION_RETENTION_MS = Number(process.env.EMPTY_SESSION_RETENTION_MS ?? 60 * 60_000);
const EMPTY_SESSION_ID = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
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
	options: { maxBytes?: number; batch?: { index: number; total: number } } = {},
) {
	const maxBytes = options.maxBytes ?? MAX_INPUT_BYTES;
	const budget = maxBytes - INPUT_WRAPPER_RESERVE;
	const base = {
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
		context: {
			limits: INPUT_LIMITS,
			omitted: omissions,
			...(options.batch ? { batch: options.batch } : {}),
		},
	};
}

export function splitInspectionBatches(sections: InspectionInputSections): InspectionInputSections[] {
	if (sections.sessions.length <= SESSIONS_PER_INSPECTION_BATCH) return [sections];
	const batches: InspectionInputSections[] = [];
	for (let offset = 0; offset < sections.sessions.length; offset += SESSIONS_PER_INSPECTION_BATCH) {
		const sessions = sections.sessions.slice(offset, offset + SESSIONS_PER_INSPECTION_BATCH);
		const sessionIds = new Set(sessions.flatMap((session) => typeof session.id === "string" ? [session.id] : []));
		batches.push({
			...sections,
			sessions,
			messages: sections.messages.filter((message) => sessionIds.has(String(message.sessionId))),
			failedTools: sections.failedTools.filter((tool) => sessionIds.has(String(tool.sessionId))),
		});
	}
	return batches;
}

export function dedupeInspectionFindings(findings: ModelInspectionResult["findings"]): ModelInspectionResult["findings"] {
	const seen = new Set<string>();
	return findings.filter((finding) => {
		const key = findingRecurrenceKey(finding);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function mergeInspectionResults(results: ModelInspectionResult[]): ModelInspectionResult {
	const seenMemories = new Set<string>();
	const memories: ModelInspectionResult["memories"] = [];
	const tree: ModelInspectionResult["tree"] = [];
	const findings: ModelInspectionResult["findings"] = [];
	for (const [batchIndex, result] of results.entries()) {
		for (const memory of result.memories) {
			const key = normalizeMemory(memory.content);
			if (!seenMemories.has(key)) {
				seenMemories.add(key);
				memories.push(memory);
			}
		}
		for (const [nodeIndex, node] of result.tree.entries()) {
			tree.push({ ...node, id: `insight:${batchIndex}:${nodeIndex}` });
		}
		for (const finding of result.findings) findings.push(finding);
	}
	return { memories, tree, findings: dedupeInspectionFindings(findings) };
}

export interface MemoryConsolidationPlan {
	/** Brand-new rows to insert as version 1. */
	inserts: ModelMemoryCandidate[];
	/** Active memories to bump occurrenceCount/lastSeenAt for. */
	reinforces: Array<{ targetId: string; candidate: ModelMemoryCandidate }>;
	/** Active memories whose corrected statement replaces them (same memoryKey, version+1). */
	supersedes: Array<{ targetId: string; candidate: ModelMemoryCandidate }>;
}

/**
 * Partitions model candidates against the active memory set. Candidates whose
 * action+targetId names a real active memory consolidate it; repeated claims
 * against the same active memory collapse to the first. A broken link or a
 * missing one degrades to a plain insert unless the exact text already exists
 * (dedup), mirroring the pre-consolidation behavior.
 */
export function planMemoryConsolidation(
	candidates: ModelMemoryCandidate[],
	existingActive: Array<{ memoryKey: string; content: string }>,
): MemoryConsolidationPlan {
	const activeIds = new Set(existingActive.map((row) => row.memoryKey));
	const existingContents = new Set(existingActive.map((row) => normalizeMemory(row.content)));
	const plan: MemoryConsolidationPlan = { inserts: [], reinforces: [], supersedes: [] };
	const claimedTargets = new Set<string>();
	for (const candidate of candidates) {
		const requestedTargetId = candidate.action && candidate.targetId && activeIds.has(candidate.targetId)
			? candidate.targetId
			: undefined;
		if (requestedTargetId && claimedTargets.has(requestedTargetId)) continue;
		const targetId = requestedTargetId;
		if (targetId && candidate.action === "reinforce") {
			claimedTargets.add(targetId);
			plan.reinforces.push({ targetId, candidate });
			continue;
		}
		if (targetId && candidate.action === "supersede") {
			claimedTargets.add(targetId);
			plan.supersedes.push({ targetId, candidate });
			continue;
		}
		if (!existingContents.has(normalizeMemory(candidate.content))) {
			plan.inserts.push(candidate);
			existingContents.add(normalizeMemory(candidate.content));
		}
	}
	return plan;
}

/** Findings dedupe/merge key: same kind + subject session + normalized summary is one recurring finding. */
export function findingRecurrenceKey(finding: { kind: string; sessionId?: string; summary: string }): string {
	return `${finding.kind}|${finding.sessionId ?? ""}|${normalizeMemory(finding.summary)}`;
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
): { baseUrl: string; model: string; apiKeyCipher: string; schedule: InspectionSchedule } | null {
	if (!settings?.baseUrl || !settings.model || !settings.apiKeyCipher) return null;
	return {
		baseUrl: settings.baseUrl,
		model: settings.model,
		apiKeyCipher: settings.apiKeyCipher,
		schedule: toInspectionSchedule(settings),
	};
}

export async function queueProjectInspection(
	userId: string,
	projectId: number,
	trigger: "manual" | "schedule",
): Promise<boolean> {
	const connection = toInspectionConnection(await readModelSettings());
	if (!connection) throw new Error("model inspection is not configured");
	await cleanEmptyUuidSessions();
	const apiKey = decryptApiKey(connection.apiKeyCipher);
	await ensureProjectAnalysisState(userId, projectId);
	const now = new Date();
	const staleBefore = new Date(now.getTime() - INSPECTION_LOCK_TTL_MS);
	// The claim-time nextInspectionAt is only a crash guard (a stuck lock stops
	// looking due after one TTL); success and failure both reschedule using the
	// configured schedule below.
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
		// full lock TTL, and reschedule at the configured schedule's next slot.
		await db
			.update(projectAnalysisStates)
			.set({
				lockedAt: null,
				nextInspectionAt: computeNextInspectionAt(connection.schedule, now),
				updatedAt: now,
			})
			.where(and(
				eq(projectAnalysisStates.userId, userId),
				eq(projectAnalysisStates.projectId, projectId),
				eq(projectAnalysisStates.lockedAt, now),
			));
		throw error;
	}
	void executeInspection(runId, userId, projectId, trigger, connection.schedule, {
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
		// A bare Date interpolated into a raw sql fragment is not serializable by
		// postgres-js (unlike mapper-typed columns); pass it as an ISO string.
		sql`not exists (
			select 1 from ${projectAnalysisStates}
			where ${projectAnalysisStates.userId} = ${projectInspections.userId}
				and ${projectAnalysisStates.projectId} = ${projectInspections.projectId}
				and ${projectAnalysisStates.lockedAt} >= ${staleBefore.toISOString()}
		)`,
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
	trigger: "manual" | "schedule",
	schedule: InspectionSchedule,
	connection: { baseUrl: string; model: string; apiKey: string },
	claimedAt: Date,
): Promise<void> {
	const startedMs = Date.now();
	let lockAt = claimedAt;
	let lastLockHeartbeatMs = startedMs;
	let lockHeartbeat: Promise<void> | undefined;
	const renewLockFromStreamActivity = () => {
		const now = new Date();
		if (lockHeartbeat || now.getTime() - lastLockHeartbeatMs < INSPECTION_LOCK_HEARTBEAT_MS) return;
		lastLockHeartbeatMs = now.getTime();
		const expectedLockAt = lockAt;
		lockHeartbeat = db.update(projectAnalysisStates)
			.set({ lockedAt: now, updatedAt: now })
			.where(and(
				eq(projectAnalysisStates.userId, userId),
				eq(projectAnalysisStates.projectId, projectId),
				eq(projectAnalysisStates.lockedAt, expectedLockAt),
			))
			.returning({ lockedAt: projectAnalysisStates.lockedAt })
			.then(([renewed]) => {
				if (renewed?.lockedAt) lockAt = renewed.lockedAt;
			})
			.catch(() => undefined)
			.finally(() => { lockHeartbeat = undefined; });
	};
	const logPayloads: unknown[] = [];
	try {
		const sections = await buildInspectionSections(userId, projectId);
		const input = toRedactable(assembleInspectionInput(sections));
		const redactedInput = redactForModel(input);
		let inputRedactions = redactedInput.count;
		let result: ModelInspectionResult;
		let responseContent: string;
		let reasoningContent: string | undefined;
		try {
			recordInspectionStage(projectId, trigger, {
				stage: "assembled",
				inspectionId: runId,
				bytes: byteSize(redactedInput.value),
				redactions: redactedInput.count,
				omitted: omittedCounts(redactedInput.value),
			});
			recordInspectionStage(projectId, trigger, {
				stage: "request_sent",
				inspectionId: runId,
				model: connection.model,
				timeoutMs: FULL_INSPECTION_TIMEOUT_MS,
			});
			const agent = await requestInspectionAgent(connection, redactedInput.value, INSPECTION_AGENT_TOOLS, {
				executeTool: (call) => executeInspectionAgentTool(userId, projectId, call),
				onTool: (step) => recordInspectionStage(projectId, trigger, {
					stage: "tool_completed",
					inspectionId: runId,
					tool: step.tool,
					round: step.round,
					status: step.status,
					resultBytes: step.resultBytes,
					redactions: step.redactionCount,
				}),
			});
			const redactedSteps = redactForModel(toRedactable(agent.steps));
			logPayloads.push({ mode: "agent", input: redactedInput.value, steps: redactedSteps.value });
			inputRedactions += redactedSteps.count;
			result = agent.result;
			responseContent = redactText(agent.content).value;
			reasoningContent = agent.reasoning == null ? undefined : redactText(agent.reasoning).value;
		} catch (error) {
			if (!(error instanceof ToolCapabilityError)) throw error;
			const batches = splitInspectionBatches(sections);
			if (batches.length > MAX_INSPECTION_BATCHES) {
				throw new Error(`inspection exceeded the ${MAX_INSPECTION_BATCHES} batch limit`);
			}
			const responses = [];
			const fallbackPayloads: unknown[] = [];
			for (const [batchOffset, batch] of batches.entries()) {
				const batchNumber = batchOffset + 1;
				const batchInput = toRedactable(assembleInspectionInput(batch, { batch: { index: batchNumber, total: batches.length } }));
				const redactedBatch = redactForModel(batchInput);
				fallbackPayloads.push(redactedBatch.value);
				inputRedactions += redactedBatch.count;
				recordInspectionStage(projectId, trigger, {
					stage: "assembled",
					inspectionId: runId,
					bytes: byteSize(redactedBatch.value),
					redactions: redactedBatch.count,
					omitted: omittedCounts(redactedBatch.value),
				});
				recordInspectionStage(projectId, trigger, {
					stage: "request_sent",
					inspectionId: runId,
					model: connection.model,
					timeoutMs: FULL_INSPECTION_TIMEOUT_MS,
				});
				if (batches.length > 1) recordInspectionDelta(projectId, runId, { type: "content", text: `\n\n--- batch ${batchNumber}/${batches.length} ---\n` });
				responses.push(await requestInspectionStreaming(connection, redactedBatch.value, {
					timeoutMs: FULL_INSPECTION_TIMEOUT_MS,
					purpose: `model inspection batch ${batchNumber}/${batches.length}`,
					onActivity: renewLockFromStreamActivity,
					onDelta: (delta) => recordInspectionDelta(projectId, runId, delta),
				}));
			}
			logPayloads.push({ mode: "batch_fallback", reason: error.message, batches: fallbackPayloads });
			result = mergeInspectionResults(responses.map((response) => response.result));
			const transcripts = responses.map((response, batchOffset) => {
				const content = redactText(response.content);
				const reasoning = response.reasoning == null ? undefined : redactText(response.reasoning);
				inputRedactions += content.count + (reasoning?.count ?? 0);
				return { batch: batchOffset + 1, content: content.value, reasoning: reasoning?.value };
			});
			responseContent = JSON.stringify(transcripts.map(({ batch, content }) => ({ batch, content })));
			const reasoning = transcripts.flatMap((entry) => entry.reasoning == null ? [] : [{ batch: entry.batch, reasoning: entry.reasoning }]);
			reasoningContent = reasoning.length > 0 ? JSON.stringify(reasoning) : undefined;
		}
		const redactedResult = redactInspectionResult(result);
		const responseRedaction = redactText(responseContent);
		const reasoningRedaction = reasoningContent == null ? undefined : redactText(reasoningContent);
		await lockHeartbeat;
		await persistInspectionResult(runId, userId, projectId, schedule, redactedResult.value, inputRedactions + redactedResult.count + responseRedaction.count + (reasoningRedaction?.count ?? 0), lockAt, {
			requestPayload: { runs: logPayloads },
			responseContent: responseRedaction.value,
			reasoningContent: reasoningRedaction?.value,
		});
		recordInspectionStage(projectId, trigger, {
			stage: "succeeded",
			inspectionId: runId,
			memories: redactedResult.value.memories.length,
			treeNodes: redactedResult.value.tree.length,
			findings: redactedResult.value.findings.length,
			elapsedMs: Date.now() - startedMs,
		});
	} catch (error) {
		const failedAt = new Date();
		const message = redactText(error instanceof Error ? error.message : String(error)).value.slice(0, 1000);
		if (logPayloads.length > 0) {
			await db.insert(projectInspectionLogs).values({ inspectionId: runId, requestPayload: { runs: logPayloads } })
				.onConflictDoNothing().catch(() => undefined);
			await pruneInspectionLogs(userId, projectId).catch(() => undefined);
		}
		recordInspectionStage(projectId, trigger, {
			stage: "failed",
			inspectionId: runId,
			error: message,
			elapsedMs: Date.now() - startedMs,
		});
		await Promise.all([
			db.update(projectInspections).set({ status: "failed", error: message, finishedAt: failedAt }).where(eq(projectInspections.id, runId)),
			db.update(projectAnalysisStates).set({
				lockedAt: null,
				lastError: message,
				nextInspectionAt: computeNextInspectionAt(schedule, failedAt),
				updatedAt: failedAt,
			}).where(and(
				eq(projectAnalysisStates.userId, userId),
				eq(projectAnalysisStates.projectId, projectId),
				eq(projectAnalysisStates.lockedAt, lockAt),
			)),
		]);
		publish({ type: "project_update", userId, projectId });
	}
}

async function buildInspectionSections(userId: string, projectId: number): Promise<InspectionInputSections> {
	const [projectRows, snapshotRows, sessionRows, memoryRows] = await Promise.all([
		db.select({ name: projects.name, gitRemote: projects.gitRemote }).from(projects).where(eq(projects.id, projectId)).limit(1),
		db.select().from(projectSnapshots).where(and(eq(projectSnapshots.userId, userId), eq(projectSnapshots.projectId, projectId))).orderBy(desc(projectSnapshots.createdAt)).limit(1),
		db.select({ id: sessions.id, title: sessions.title, branch: sessions.branch, state: sessions.state, lastActivityAt: sessions.lastActivityAt }).from(sessions).where(and(eq(sessions.userId, userId), eq(sessions.projectId, projectId))).orderBy(desc(sessions.lastActivityAt)).limit(SESSION_LIMIT),
		db.select({ id: projectMemories.memoryKey, kind: projectMemories.kind, content: projectMemories.content, status: projectMemories.status, occurrenceCount: projectMemories.occurrenceCount }).from(projectMemories).where(and(eq(projectMemories.userId, userId), eq(projectMemories.projectId, projectId), isNull(projectMemories.supersededAt))).orderBy(desc(projectMemories.createdAt), desc(projectMemories.id)).limit(MEMORY_LIMIT),
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
	return {
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
	};
}

async function persistInspectionResult(
	runId: string,
	userId: string,
	projectId: number,
	schedule: InspectionSchedule,
	result: ModelInspectionResult,
	redactionCount: number,
	claimedAt: Date,
	log: { requestPayload: unknown; responseContent: string; reasoningContent?: string },
): Promise<void> {
	const [projectRow, snapshotRow, existingRows, existingFindingRows] = await Promise.all([
		db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1),
		db.select({ files: projectSnapshots.files }).from(projectSnapshots).where(and(eq(projectSnapshots.userId, userId), eq(projectSnapshots.projectId, projectId))).orderBy(desc(projectSnapshots.createdAt)).limit(1),
		db.select({
			id: projectMemories.id,
			memoryKey: projectMemories.memoryKey,
			version: projectMemories.version,
			content: projectMemories.content,
			status: projectMemories.status,
			moduleIds: projectMemories.moduleIds,
			evidence: projectMemories.evidence,
			occurrenceCount: projectMemories.occurrenceCount,
		}).from(projectMemories).where(and(eq(projectMemories.userId, userId), eq(projectMemories.projectId, projectId), isNull(projectMemories.supersededAt))),
		db.select({
			id: projectFindings.id,
			kind: projectFindings.kind,
			severity: projectFindings.severity,
			summary: projectFindings.summary,
			detail: projectFindings.detail,
			sessionId: projectFindings.sessionId,
			evidence: projectFindings.evidence,
		}).from(projectFindings).where(and(eq(projectFindings.userId, userId), eq(projectFindings.projectId, projectId))),
	]);
	const sessionRows = await db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.userId, userId), eq(sessions.projectId, projectId)));
	const allowedSessions = new Set(sessionRows.map((row) => row.id));
	const turnRows = sessionRows.length > 0
		? await db.select({ sessionId: turns.sessionId, position: turns.position }).from(turns).where(inArray(turns.sessionId, sessionRows.map((row) => row.id)))
		: [];
	const allowedTurns = new Set(turnRows.map((row) => `${row.sessionId}:${row.position}`));
	const validEvidence = (entry: { sessionId: string; turnPosition?: number }) =>
		allowedSessions.has(entry.sessionId) && (entry.turnPosition === undefined || allowedTurns.has(`${entry.sessionId}:${entry.turnPosition}`));
	const files = asSnapshotFiles(snapshotRow[0]?.files);
	const structure = buildStructureTree(files, projectRow[0]?.name ?? "Project");
	const structureIds = new Set(structure.map((node) => node.id));
	const memories = retainStructureModuleIds(result.memories, structureIds);
	const plan = planMemoryConsolidation(memories, existingRows.map((row) => ({ memoryKey: row.memoryKey, content: row.content })));
	const byTargetId = new Map(existingRows.map((row) => [row.memoryKey, row]));
	const tree = mergeProjectTree(structure, result.tree.filter((node) => !node.sessionId || validEvidence({ sessionId: node.sessionId, turnPosition: node.turnPosition })));
	// Findings about a session that is gone (or never existed) are dropped;
	// cross-session findings carry no sessionId and always pass.
	const findings = dedupeInspectionFindings(
		result.findings.filter((finding) => !finding.sessionId || allowedSessions.has(finding.sessionId)),
	);
	const now = new Date();
	await db.transaction(async (tx) => {
		// Fence all result writes, not only the unlock, against a replaced claim.
		const [owner] = await tx.select({ id: projectAnalysisStates.id }).from(projectAnalysisStates)
			.where(and(eq(projectAnalysisStates.userId, userId), eq(projectAnalysisStates.projectId, projectId), eq(projectAnalysisStates.lockedAt, claimedAt)))
			.for("update").limit(1);
		if (!owner) throw new Error("inspection claim expired; result discarded");
		if (plan.inserts.length > 0) {
			await tx.insert(projectMemories).values(plan.inserts.map((memory) => ({
				memoryKey: randomUUID(),
				userId,
				projectId,
				version: 1,
				kind: memory.kind,
				content: memory.content,
				// The model parser only admits directly evidenced high-confidence memories.
				status: "confirmed",
				moduleIds: memory.moduleIds,
				evidence: memory.evidence.filter(validEvidence),
				sourceInspectionId: runId,
				lastSeenInspectionId: runId,
			})));
		}
		for (const { targetId, candidate } of plan.reinforces) {
			const row = byTargetId.get(targetId);
			if (!row) continue;
			await tx.update(projectMemories).set({
				occurrenceCount: row.occurrenceCount + 1,
				lastSeenAt: now,
				lastSeenInspectionId: runId,
				moduleIds: mergeModuleIds(row.moduleIds, candidate.moduleIds),
				evidence: mergeEvidenceRows(row.evidence, candidate.evidence.filter(validEvidence)),
			}).where(and(eq(projectMemories.id, row.id), isNull(projectMemories.supersededAt)));
		}
		for (const { targetId, candidate } of plan.supersedes) {
			const row = byTargetId.get(targetId);
			if (!row) continue;
			const [superseded] = await tx.update(projectMemories).set({ supersededAt: now })
				.where(and(eq(projectMemories.id, row.id), isNull(projectMemories.supersededAt)))
				.returning({ id: projectMemories.id });
			if (!superseded) continue;
			// The corrected statement carries the old row's user disposition
			// forward (pinned stays pinned); an archived memory is not resurrected.
			await tx.insert(projectMemories).values({
				memoryKey: row.memoryKey,
				userId,
				projectId,
				version: row.version + 1,
				kind: candidate.kind,
				content: candidate.content,
				status: supersedeStatus(row.status),
				moduleIds: candidate.moduleIds,
				evidence: mergeEvidenceRows(row.evidence, candidate.evidence.filter(validEvidence)),
				occurrenceCount: row.occurrenceCount + 1,
				sourceInspectionId: runId,
				lastSeenInspectionId: runId,
			});
		}
		const findingIndex = new Map(existingFindingRows.map((row) => [findingRecurrenceKey({ ...row, sessionId: row.sessionId ?? undefined }), row]));
		for (const finding of findings) {
			const evidence = finding.evidence.filter(validEvidence);
			const existingFinding = findingIndex.get(findingRecurrenceKey(finding));
			if (existingFinding) {
				await tx.update(projectFindings).set({
					occurrenceCount: sql`${projectFindings.occurrenceCount} + 1`,
					lastSeenAt: now,
					...(finding.detail ? { detail: finding.detail, severity: finding.severity } : {}),
					evidence: mergeEvidenceRows(existingFinding.evidence, evidence),
				}).where(eq(projectFindings.id, existingFinding.id));
				continue;
			}
			await tx.insert(projectFindings).values({
				userId,
				projectId,
				kind: finding.kind,
				severity: finding.severity,
				summary: finding.summary,
				detail: finding.detail,
				sessionId: finding.sessionId,
				evidence,
				sourceInspectionId: runId,
			});
		}
		// Guarded by the claim timestamp: if this run's lock expired and a newer
		// run claimed the project, this completion must not overwrite the new
		// claim's schedule or clear its lock.
		await tx.update(projectAnalysisStates).set({
			latestTree: tree,
			lockedAt: null,
			lastInspectionAt: now,
			nextInspectionAt: computeNextInspectionAt(schedule, now),
			lastError: null,
			updatedAt: now,
		}).where(and(
			eq(projectAnalysisStates.userId, userId),
			eq(projectAnalysisStates.projectId, projectId),
			eq(projectAnalysisStates.lockedAt, claimedAt),
		));
		await tx.update(projectInspections).set({ status: "done", redactionCount, finishedAt: now }).where(eq(projectInspections.id, runId));
		await tx.insert(projectInspectionLogs).values({
			inspectionId: runId,
			requestPayload: log.requestPayload,
			responseContent: log.responseContent,
			reasoningContent: log.reasoningContent,
		}).onConflictDoNothing({ target: projectInspectionLogs.inspectionId });
	});
	await pruneInspectionLogs(userId, projectId);
	await pruneProjectFindings(userId, projectId);
	publish({ type: "project_update", userId, projectId });
}

/** Keeps only the newest RETAINED_PROJECT_FINDINGS findings per project, ordered by recency of last sighting. */
async function pruneProjectFindings(userId: string, projectId: number): Promise<void> {
	await db.execute(sql`
		DELETE FROM project_findings
		WHERE id IN (
			SELECT id FROM project_findings
			WHERE user_id = ${userId} AND project_id = ${projectId}
			ORDER BY last_seen_at DESC
			OFFSET ${RETAINED_PROJECT_FINDINGS}
		)
	`);
}

/** A superseding inspection keeps the user's disposition; archived stays archived, a fresh candidate graduates to confirmed. */
function supersedeStatus(status: string): string {
	if (status === "archived") return "archived";
	if (status === "candidate") return "confirmed";
	return status;
}

function mergeModuleIds(current: unknown, incoming: string[]): string[] {
	return [...new Set([...asModuleIds(current), ...incoming])].slice(0, 3);
}

function mergeEvidenceRows(current: unknown, incoming: Array<{ sessionId: string; turnPosition?: number }>): Array<{ sessionId: string; turnPosition?: number }> {
	const merged = [...asEvidence(current), ...incoming];
	const seen = new Set<string>();
	return merged.filter((entry) => {
		const key = `${entry.sessionId}:${entry.turnPosition ?? ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	}).slice(0, MERGED_EVIDENCE_LIMIT);
}

/** Keeps only the newest RETAINED_INSPECTION_LOGS transcripts per project; run metadata rows are untouched. */
async function pruneInspectionLogs(userId: string, projectId: number): Promise<void> {
	await db.execute(sql`
		DELETE FROM project_inspection_logs
		WHERE inspection_id IN (
			SELECT l.inspection_id
			FROM project_inspection_logs l
			JOIN project_inspections i ON i.id = l.inspection_id
			WHERE i.user_id = ${userId} AND i.project_id = ${projectId}
			ORDER BY i.started_at DESC
			OFFSET ${RETAINED_INSPECTION_LOGS}
		)
	`);
}

function byteSize(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value) ?? "");
	} catch {
		return 0;
	}
}

function omittedCounts(payload: unknown): Record<string, number> {
	const omitted = (payload as { context?: { omitted?: unknown } } | null)?.context?.omitted;
	return omitted && typeof omitted === "object" ? { ...(omitted as Record<string, number>) } : {};
}

export function retainStructureModuleIds(
	memories: ModelInspectionResult["memories"],
	structureIds: Set<string>,
): ModelInspectionResult["memories"] {
	return memories.map((memory) => ({
		...memory,
		moduleIds: [...new Set(memory.moduleIds.filter((id) => structureIds.has(id)))].slice(0, 3),
	}));
}

/** Strictly empty session metadata, excluding mandatory transport fields (user, machine, cwd). */
export function isStrictlyEmptyUuidSession(record: {
	id: string;
	title: string | null;
	branch: string | null;
	modelId: string | null;
	turnCount: number;
	totalCostUsd: number;
	inputTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	contextTokens: number;
	contextWindow: number;
}): boolean {
	return new RegExp(EMPTY_SESSION_ID, "i").test(record.id)
		&& record.title === null
		&& record.branch === null
		&& record.modelId === null
		&& record.turnCount === 0
		&& record.totalCostUsd === 0
		&& record.inputTokens === 0
		&& record.cacheReadTokens === 0
		&& record.totalTokens === 0
		&& record.contextTokens === 0
		&& record.contextWindow === 0;
}

export async function cleanEmptyUuidSessions(): Promise<void> {
	try {
		const cleared = await sweepEmptyUuidSessions();
		if (cleared.length > 0) process.stderr.write(`[pi-kanban] inspection removed ${cleared.length} empty session(s): ${cleared.join(", ")}\n`);
	} catch (error) {
		process.stderr.write(`[pi-kanban] inspection empty-session cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
	}
}

/** Remove stale UUID placeholder sessions only when neither content nor project artifacts exist. */
export async function sweepEmptyUuidSessions(projectId?: number): Promise<string[]> {
	const cutoff = new Date(Date.now() - EMPTY_SESSION_RETENTION_MS);
	const predicate = and(
		sql`${sessions.id} ~ ${EMPTY_SESSION_ID}`,
		isNull(sessions.title),
		isNull(sessions.branch),
		isNull(sessions.modelId),
		eq(sessions.turnCount, 0),
		eq(sessions.totalCostUsd, 0),
		eq(sessions.inputTokens, 0),
		eq(sessions.cacheReadTokens, 0),
		eq(sessions.totalTokens, 0),
		eq(sessions.contextTokens, 0),
		eq(sessions.contextWindow, 0),
		lt(sessions.lastActivityAt, cutoff),
		sql`${sessions.state} in ('finished', 'offline')`,
		sql`not exists (select 1 from ${turns} where ${turns.sessionId} = ${sessions.id})`,
		sql`not exists (select 1 from ${messages} where ${messages.sessionId} = ${sessions.id})`,
		sql`not exists (select 1 from ${toolCalls} where ${toolCalls.sessionId} = ${sessions.id})`,
		sql`not exists (select 1 from ${todoLists} where ${todoLists.sessionId} = ${sessions.id})`,
		sql`not exists (select 1 from ${approvals} where ${approvals.sessionId} = ${sessions.id})`,
		sql`not exists (select 1 from ${projectSnapshots} where ${projectSnapshots.sessionId} = ${sessions.id})`,
		...(projectId === undefined ? [] : [eq(sessions.projectId, projectId)]),
	);
	const removed = await db.delete(sessions).where(predicate).returning({ id: sessions.id });
	return removed.map((session) => session.id);
}

export function toMemoryDto(row: typeof projectMemories.$inferSelect): ProjectMemoryDTO {
	return {
		id: row.memoryKey,
		version: row.version,
		kind: row.kind as ProjectMemoryKind,
		content: row.content,
		status: row.status as ProjectMemoryStatus,
		moduleIds: asModuleIds(row.moduleIds),
		evidence: asEvidence(row.evidence),
		occurrenceCount: row.occurrenceCount,
		createdAt: row.createdAt.getTime(),
		lastSeenAt: row.lastSeenAt.getTime(),
	};
}

export type ReferenceRulesMemory = Pick<ProjectMemoryDTO, "kind" | "content" | "status" | "moduleIds" | "occurrenceCount">;

export function toFindingDto(row: typeof projectFindings.$inferSelect): SessionFindingDTO {
	return {
		id: row.id,
		kind: row.kind as SessionFindingKind,
		severity: row.severity as SessionFindingSeverity,
		summary: row.summary,
		detail: row.detail ?? undefined,
		sessionId: row.sessionId ?? undefined,
		evidence: asEvidence(row.evidence),
		occurrenceCount: row.occurrenceCount,
		createdAt: row.createdAt.getTime(),
		lastSeenAt: row.lastSeenAt.getTime(),
	};
}

/** Reference-rule export: confirmed/pinned memories grouped by module. Never a replacement for an existing AGENTS.md. */
export function renderReferenceRulesMarkdown(
	projectName: string,
	memories: ReferenceRulesMemory[],
	tree: ProjectTreeNodeDTO[],
): string {
	const labels = new Map(tree.map((node) => [node.id, node.label]));
	const groups = new Map<string, ReferenceRulesMemory[]>();
	for (const memory of memories) {
		if (memory.status !== "confirmed" && memory.status !== "pinned") continue;
		const moduleId = memory.moduleIds.find((id) => labels.has(id));
		const key = moduleId ?? "";
		const bucket = groups.get(key) ?? [];
		bucket.push(memory);
		groups.set(key, bucket);
	}
	const lines = [
		`# ${projectName}: suggested project rules`,
		"",
		"> Reference only. Review each suggestion and manually merge relevant rules into the appropriate existing AGENTS.md file.",
		"> Do not replace an existing AGENTS.md with this file. Existing files may contain scoped, security, testing, and manually maintained rules that inspections cannot reproduce.",
		"",
		"Generated by pi-kanban from confirmed and pinned inspection memories.",
		"",
	];
	const sortedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
	for (const [moduleId, bucket] of sortedGroups) {
		const label = moduleId ? labels.get(moduleId) ?? moduleId : "General";
		lines.push(`## ${label}`);
		for (const memory of bucket) {
			const occurrences = memory.occurrenceCount > 1 ? ` (seen ${memory.occurrenceCount}×)` : "";
			lines.push(`- [${memory.kind}] ${memory.content}${occurrences}`);
		}
		lines.push("");
	}
	return lines.join("\n");
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
			findings: result.findings.map((finding) => ({ ...finding, summary: redact(finding.summary) ?? "", detail: redact(finding.detail) })),
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

function asModuleIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))].slice(0, 3);
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

function toRedactable(value: unknown): Redactable {
	try {
		return JSON.parse(JSON.stringify(value)) as Redactable;
	} catch {
		throw new Error("inspection input could not be serialized");
	}
}
