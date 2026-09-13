import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { MemoryHitDTO, ProjectMemoryKind, ProjectMemoryStatus, SearchScope, SearchResultDTO, SessionHitDTO } from "@pi-kanban/shared";
import { SEARCH_MAX_RESULTS, tokenizeForSearch } from "@pi-kanban/shared";
import { db } from "./db/index.js";
import { messages, projectMemories, projects, sessions, toolCalls, turns } from "./db/schema.js";

/**
 * Cross-project search over the user's synced knowledge base. Candidate rows
 * are prefiltered by the GIN-indexed token arrays (bigram/word tokens written
 * at ingest by the shared tokenizer), then ranked app-side with BM25 over the
 * stored token multiset — same ranking family as the local session-search
 * extension, so cloud and local results feel alike.
 */

// Candidate caps per table after the token-overlap prefilter (recency-ordered).
const MESSAGE_CANDIDATES = 1_200;
const TURN_CANDIDATES = 400;
const TOOL_RESULT_CANDIDATES = 400;
const MEMORY_CANDIDATES = 300;
const SNIPPET_WIDTH = 120;
const SNIPPET_MAX = 260;

const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** Per-source field weights: prompts carry intent, memories carry decisions. */
export const FIELD_WEIGHTS = {
	turnPrompt: 2.0,
	messageExcerpt: 1.0,
	toolResult: 0.7,
	memoryContent: 1.5,
} as const;
/** A session hit combines its best row with a small bonus per extra hit. */
const SESSION_EXTRA_HIT_BONUS = 0.25;

export function parseSearchQuery(query: string): string[] {
	return [...new Set(tokenizeForSearch(query))];
}

function tokenCounts(tokens: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
	return counts;
}

/** BM25 over the stored token multiset; IDF is computed across the candidate pool. */
export function scoreRows<T>(rows: Array<{ data: T; tokens: string[] | null; weight: number }>, queryTokens: string[]): Array<{ data: T; score: number }> {
	const prepared = rows.map((row) => ({
		data: row.data,
		weight: row.weight,
		counts: tokenCounts(row.tokens ?? []),
		length: Math.max(1, row.tokens?.length ?? 1),
	}));
	const averageLength = prepared.length > 0
		? prepared.reduce((sum, row) => sum + row.length, 0) / prepared.length
		: 1;
	const idf = new Map<string, number>();
	for (const token of queryTokens) {
		const documentFrequency = prepared.filter((row) => (row.counts.get(token) ?? 0) > 0).length;
		idf.set(token, Math.log(1 + (prepared.length - documentFrequency + 0.5) / (documentFrequency + 0.5)));
	}
	const scored: Array<{ data: T; score: number }> = [];
	for (const row of prepared) {
		let score = 0;
		let matched = false;
		for (const token of queryTokens) {
			const termFrequency = row.counts.get(token) ?? 0;
			if (termFrequency === 0) continue;
			matched = true;
			const norm = termFrequency + BM25_K1 * (1 - BM25_B + BM25_B * (row.length / averageLength));
			score += row.weight * (idf.get(token) ?? 0) * ((termFrequency * (BM25_K1 + 1)) / norm);
		}
		if (matched) scored.push({ data: row.data, score });
	}
	return scored;
}

/** Snippet around the first occurrence of any query term (case-insensitive). */
export function buildSnippet(text: string | null | undefined, queryTokens: string[], width = SNIPPET_WIDTH): string | undefined {
	if (!text) return undefined;
	const flat = text.replace(/\s+/g, " ").trim();
	if (!flat) return undefined;
	const lower = flat.toLocaleLowerCase();
	let index = -1;
	let length = 0;
	for (const token of queryTokens) {
		const found = lower.indexOf(token.toLocaleLowerCase());
		if (found !== -1 && (index === -1 || found < index)) {
			index = found;
			length = token.length;
		}
	}
	const start = index === -1 ? 0 : Math.max(0, index - Math.floor(width / 3));
	const end = index === -1 ? Math.min(flat.length, SNIPPET_WIDTH * 2) : Math.min(flat.length, index + length + width);
	const snippet = flat.slice(start, end);
	return snippet.length > SNIPPET_MAX ? `${snippet.slice(0, SNIPPET_MAX)}…` : snippet || undefined;
}

interface SessionRowHit {
	sessionId: string;
	title: string | null;
	projectId: number | null;
	projectName: string | null;
	matchedAt: number;
	turnPosition: number | null;
	text: string | null;
	score: number;
}

/** Collapses scored rows into per-session hits: best score + hit-count bonus. */
export function aggregateSessionHits(hits: SessionRowHit[], queryTokens: string[], limit: number): SessionHitDTO[] {
	const bySession = new Map<string, SessionRowHit[]>();
	for (const hit of hits) {
		const list = bySession.get(hit.sessionId) ?? [];
		list.push(hit);
		bySession.set(hit.sessionId, list);
	}
	const aggregated: SessionHitDTO[] = [];
	for (const [sessionId, list] of bySession) {
		const sorted = [...list].sort((a, b) => b.score - a.score || b.matchedAt - a.matchedAt);
		const best = sorted[0];
		aggregated.push({
			sessionId,
			title: best.title ?? undefined,
			projectId: best.projectId,
			projectName: best.projectName ?? best.title ?? sessionId,
			score: best.score + SESSION_EXTRA_HIT_BONUS * (sorted.length - 1),
			snippet: buildSnippet(best.text, queryTokens),
			matchedAt: best.matchedAt,
			turnPosition: best.turnPosition ?? undefined,
		});
	}
	return aggregated.sort((a, b) => b.score - a.score || b.matchedAt - a.matchedAt).slice(0, limit);
}

function tokenOverlap(column: AnyPgColumn, tokens: string[]) {
	return sql`${column} && ${tokens}::text[]`;
}

export async function searchUserContent(
	userId: string,
	query: string,
	options: { scope?: SearchScope; limit?: number } = {},
): Promise<SearchResultDTO> {
	const limit = Math.min(Math.max(1, options.limit ?? 10), SEARCH_MAX_RESULTS);
	const scope = options.scope ?? "all";
	const queryTokens = parseSearchQuery(query);
	if (queryTokens.length === 0) return { query, sessions: [], memories: [] };
	const [messageRows, turnRows, toolRows, memoryRows] = await Promise.all([
		scope === "memories"
			? Promise.resolve([])
			: db.select({
				sessionId: messages.sessionId,
				turnPosition: messages.turnPosition,
				excerpt: messages.excerpt,
				createdAt: messages.createdAt,
				tokens: messages.searchTokens,
				title: sessions.title,
				projectId: sessions.projectId,
				projectName: projects.name,
			}).from(messages)
				.innerJoin(sessions, eq(messages.sessionId, sessions.id))
				.leftJoin(projects, eq(sessions.projectId, projects.id))
				.where(and(eq(sessions.userId, userId), tokenOverlap(messages.searchTokens, queryTokens)))
				.orderBy(desc(messages.createdAt))
				.limit(MESSAGE_CANDIDATES),
		scope === "memories"
			? Promise.resolve([])
			: db.select({
				sessionId: turns.sessionId,
				position: turns.position,
				prompt: turns.prompt,
				startedAt: turns.startedAt,
				tokens: turns.searchTokens,
				title: sessions.title,
				projectId: sessions.projectId,
				projectName: projects.name,
			}).from(turns)
				.innerJoin(sessions, eq(turns.sessionId, sessions.id))
				.leftJoin(projects, eq(sessions.projectId, projects.id))
				.where(and(eq(sessions.userId, userId), tokenOverlap(turns.searchTokens, queryTokens)))
				.orderBy(desc(turns.startedAt))
				.limit(TURN_CANDIDATES),
		scope === "memories"
			? Promise.resolve([])
			: db.select({
				sessionId: toolCalls.sessionId,
				turnPosition: toolCalls.turnPosition,
				resultExcerpt: toolCalls.resultExcerpt,
				startedAt: toolCalls.startedAt,
				tokens: toolCalls.searchTokens,
				title: sessions.title,
				projectId: sessions.projectId,
				projectName: projects.name,
			}).from(toolCalls)
				.innerJoin(sessions, eq(toolCalls.sessionId, sessions.id))
				.leftJoin(projects, eq(sessions.projectId, projects.id))
				.where(and(eq(sessions.userId, userId), tokenOverlap(toolCalls.searchTokens, queryTokens)))
				.orderBy(desc(toolCalls.startedAt))
				.limit(TOOL_RESULT_CANDIDATES),
		scope === "sessions"
			? Promise.resolve([])
			: db.select({
				memoryKey: projectMemories.memoryKey,
				kind: projectMemories.kind,
				content: projectMemories.content,
				status: projectMemories.status,
				scope: projectMemories.scope,
				lastSeenAt: projectMemories.lastSeenAt,
				tokens: projectMemories.searchTokens,
				projectId: projectMemories.projectId,
				projectName: projects.name,
			}).from(projectMemories)
				.leftJoin(projects, eq(projectMemories.projectId, projects.id))
				.where(and(
					eq(projectMemories.userId, userId),
					isNull(projectMemories.supersededAt),
					tokenOverlap(projectMemories.searchTokens, queryTokens),
				))
				.limit(MEMORY_CANDIDATES),
	]);
	const sessionRows: SessionRowHit[] = [
		...scoreRows(messageRows.map((row) => ({
			data: row,
			tokens: row.tokens,
			weight: FIELD_WEIGHTS.messageExcerpt,
		})), queryTokens).map(({ data, score }) => ({
			sessionId: data.sessionId,
			title: data.title,
			projectId: data.projectId,
			projectName: data.projectName,
			matchedAt: data.createdAt.getTime(),
			turnPosition: data.turnPosition,
			text: data.excerpt,
			score,
		})),
		...scoreRows(turnRows.map((row) => ({
			data: row,
			tokens: row.tokens,
			weight: FIELD_WEIGHTS.turnPrompt,
		})), queryTokens).map(({ data, score }) => ({
			sessionId: data.sessionId,
			title: data.title,
			projectId: data.projectId,
			projectName: data.projectName,
			matchedAt: data.startedAt.getTime(),
			turnPosition: data.position,
			text: data.prompt,
			score,
		})),
		...scoreRows(toolRows.map((row) => ({
			data: row,
			tokens: row.tokens,
			weight: FIELD_WEIGHTS.toolResult,
		})), queryTokens).map(({ data, score }) => ({
			sessionId: data.sessionId,
			title: data.title,
			projectId: data.projectId,
			projectName: data.projectName,
			matchedAt: data.startedAt.getTime(),
			turnPosition: data.turnPosition,
			text: data.resultExcerpt,
			score,
		})),
	];
	const memoryHits = scope === "sessions" ? [] : scoreRows(memoryRows.map((row) => ({
		data: row,
		tokens: row.tokens,
		weight: FIELD_WEIGHTS.memoryContent,
	})), queryTokens)
		.map(({ data, score }) => ({
			memoryId: data.memoryKey,
			projectId: data.projectId,
			projectName: data.projectName ?? (data.scope === "global" ? "global" : "—"),
			kind: data.kind as ProjectMemoryKind,
			scope: data.scope === "global" ? "global" : "project",
			status: data.status as ProjectMemoryStatus,
			content: data.content,
			score,
			lastSeenAt: data.lastSeenAt.getTime(),
		} satisfies MemoryHitDTO))
		.sort((a, b) => b.score - a.score || b.lastSeenAt - a.lastSeenAt)
		.slice(0, limit);
	return {
		query,
		sessions: aggregateSessionHits(sessionRows, queryTokens, limit),
		memories: memoryHits,
	};
}

// ---------------------------------------------------------------------------
// Ingest-time tokenization + one-time backfill of pre-existing rows
// ---------------------------------------------------------------------------

/** Tokens for a report text; only absent text stays null (unsearchable). */
export function searchTokensFor(text: string | null | undefined): string[] | null {
	if (text == null) return null;
	return tokenizeForSearch(text);
}

const BACKFILL_CHUNK = 500;

async function backfillMessages(): Promise<number> {
	let total = 0;
	while (true) {
		const rows = await db.select({ id: messages.id, excerpt: messages.excerpt })
			.from(messages)
			.where(and(isNull(messages.searchTokens), isNotNull(messages.excerpt)))
			.orderBy(asc(messages.id))
			.limit(BACKFILL_CHUNK);
		if (rows.length === 0) return total;
		await Promise.all(rows.map((row) => db.update(messages)
			.set({ searchTokens: searchTokensFor(row.excerpt) })
			.where(and(eq(messages.id, row.id), isNull(messages.searchTokens)))));
		total += rows.length;
	}
}

async function backfillTurns(): Promise<number> {
	let total = 0;
	while (true) {
		const rows = await db.select({ id: turns.id, prompt: turns.prompt })
			.from(turns)
			.where(isNull(turns.searchTokens))
			.orderBy(asc(turns.id))
			.limit(BACKFILL_CHUNK);
		if (rows.length === 0) return total;
		await Promise.all(rows.map((row) => db.update(turns)
			.set({ searchTokens: searchTokensFor(row.prompt) })
			.where(and(eq(turns.id, row.id), isNull(turns.searchTokens)))));
		total += rows.length;
	}
}

async function backfillToolResults(): Promise<number> {
	let total = 0;
	while (true) {
		const rows = await db.select({ id: toolCalls.id, resultExcerpt: toolCalls.resultExcerpt })
			.from(toolCalls)
			.where(and(isNull(toolCalls.searchTokens), isNotNull(toolCalls.resultExcerpt)))
			.orderBy(asc(toolCalls.id))
			.limit(BACKFILL_CHUNK);
		if (rows.length === 0) return total;
		await Promise.all(rows.map((row) => db.update(toolCalls)
			.set({ searchTokens: searchTokensFor(row.resultExcerpt) })
			.where(and(eq(toolCalls.id, row.id), isNull(toolCalls.searchTokens)))));
		total += rows.length;
	}
}

async function backfillMemories(): Promise<number> {
	let total = 0;
	while (true) {
		const rows = await db.select({ id: projectMemories.id, content: projectMemories.content })
			.from(projectMemories)
			.where(isNull(projectMemories.searchTokens))
			.orderBy(asc(projectMemories.id))
			.limit(BACKFILL_CHUNK);
		if (rows.length === 0) return total;
		await Promise.all(rows.map((row) => db.update(projectMemories)
			.set({ searchTokens: searchTokensFor(row.content) })
			.where(and(eq(projectMemories.id, row.id), isNull(projectMemories.searchTokens)))));
		total += rows.length;
	}
}

/** Indexes pre-existing rows; idempotent, safe to run at every boot. */
export async function backfillSearchTokens(): Promise<void> {
	const [messageCount, turnCount, toolCount, memoryCount] = await Promise.all([
		backfillMessages(),
		backfillTurns(),
		backfillToolResults(),
		backfillMemories(),
	]);
	const total = messageCount + turnCount + toolCount + memoryCount;
	if (total > 0) {
		process.stdout.write(`[pi-kanban] search backfill indexed ${total} row(s) (messages ${messageCount}, turns ${turnCount}, tool results ${toolCount}, memories ${memoryCount})\n`);
	}
}
