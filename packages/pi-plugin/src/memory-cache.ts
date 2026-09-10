import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryDigestMessage } from "@pi-kanban/shared";

/** Budget for the memory block appended to the system prompt, in bytes. */
export const MEMORY_PROMPT_BUDGET_BYTES = 4_096;
/** Disk cache freshness window; absolute timestamps, stale entries are dropped. */
export const MEMORY_CACHE_TTL_MS = 7 * 24 * 60 * 60_000;

interface CacheEntry {
	digest: MemoryDigestMessage;
	cachedAt: number;
}

interface CacheFile {
	version: 1;
	digests: Record<string, CacheEntry>;
}

/** Stable per-project key derivable at session_start without a server round-trip. */
export function projectKey(gitRemote: string | undefined, cwd: string): string {
	return gitRemote ?? cwd;
}

function cacheFile(dir: string): string {
	return join(dir, "pi-kanban-memories.json");
}

function readCache(dir: string): CacheFile {
	try {
		const parsed = JSON.parse(readFileSync(cacheFile(dir), "utf8")) as CacheFile;
		if (parsed?.version === 1 && parsed.digests && typeof parsed.digests === "object") return parsed;
	} catch {
		// Missing or corrupt cache = cold start.
	}
	return { version: 1, digests: {} };
}

export function loadCachedDigest(dir: string, key: string, now = Date.now()): MemoryDigestMessage | null {
	const entry = readCache(dir).digests[key];
	if (!entry?.digest || typeof entry.cachedAt !== "number") return null;
	if (now - entry.cachedAt > MEMORY_CACHE_TTL_MS) return null;
	return entry.digest;
}

/** All cache entries with age, freshest first — for /kanban-status. */
export function cacheStats(dir: string, now = Date.now()): Array<{ key: string; revision: string; ageMs: number }> {
	const stats: Array<{ key: string; revision: string; ageMs: number }> = [];
	for (const [key, entry] of Object.entries(readCache(dir).digests)) {
		if (!entry?.digest || typeof entry.cachedAt !== "number") continue;
		stats.push({ key, revision: entry.digest.revision, ageMs: Math.max(0, now - entry.cachedAt) });
	}
	return stats.sort((a, b) => a.ageMs - b.ageMs);
}

/** Merges one digest into the cache. No-op when the revision is unchanged; IO errors are swallowed. */
export function saveDigest(dir: string, key: string, digest: MemoryDigestMessage, now = Date.now()): void {
	const cache = readCache(dir);
	if (cache.digests[key]?.digest?.revision === digest.revision) return;
	cache.digests[key] = { digest, cachedAt: now };
	try {
		mkdirSync(dir, { recursive: true });
		const tmp = `${cacheFile(dir)}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(cache));
		renameSync(tmp, cacheFile(dir));
	} catch {
		// The cache only enables offline injection; losing one write is fine.
	}
}

/**
 * Renders the bounded advisory block appended to the system prompt. Lines are
 * dropped whole from the tail once the byte budget is reached; undefined when
 * the digest has nothing worth injecting.
 */
export function renderMemoryPrompt(digest: MemoryDigestMessage, budgetBytes = MEMORY_PROMPT_BUDGET_BYTES): string | undefined {
	const lines: string[] = [];
	if (digest.memories.length > 0) {
		lines.push("Project memory (pi-kanban): confirmed observations from automated inspections of past sessions in this project. Advisory — apply when relevant, ignore if outdated or contradicted by the repo.");
		for (const memory of digest.memories) {
			lines.push(`- [${memory.kind}] ${memory.content}${occurrenceSuffix(memory.occurrenceCount)}`);
		}
	}
	if (digest.findings.length > 0) {
		lines.push("Known recurring issues (pi-kanban):");
		for (const finding of digest.findings) {
			lines.push(`- [${finding.severity}][${finding.kind}] ${finding.summary}${occurrenceSuffix(finding.occurrenceCount)}`);
		}
	}
	if (lines.length === 0) return undefined;
	let bytes = Buffer.byteLength(lines[0]);
	if (bytes > budgetBytes) return undefined;
	const out = [lines[0]];
	for (const line of lines.slice(1)) {
		const cost = Buffer.byteLength(`\n${line}`);
		if (bytes + cost > budgetBytes) break;
		bytes += cost;
		out.push(line);
	}
	return out.join("\n");
}

function occurrenceSuffix(count: number): string {
	return count > 1 ? ` (seen ${count}×)` : "";
}
