import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_MEMORY_ISSUE_MAX_AGE_MS, PROJECT_MEMORY_MAX_AGE_MS, type MemoryDigestMessage } from "@pi-kanban/shared";
import {
	loadCachedDigest,
	MEMORY_CACHE_TTL_MS,
	projectKey,
	renderMemoryPrompt,
	saveDigest,
} from "../src/memory-cache.js";

const NOW = Date.UTC(2025, 0, 1);

function digest(overrides: Partial<MemoryDigestMessage> = {}): MemoryDigestMessage {
	return {
		type: "memory_digest",
		projectId: 1,
		projectName: "p",
		revision: "rev-1",
		generatedAt: 0,
		memories: [{ kind: "pattern", content: "prefer pnpm", status: "confirmed", occurrenceCount: 3, lastSeenAt: NOW }],
		findings: [{ kind: "tool_misuse", severity: "warning", summary: "rm -rf on paths with spaces", occurrenceCount: 2, lastSeenAt: 0 }],
		...overrides,
	};
}

// projectKey prefers the remote so clones at different paths share one entry.
assert.equal(projectKey("git@host:o/r.git", "/any/path"), "git@host:o/r.git");
assert.equal(projectKey(undefined, "/repo/path"), "/repo/path");

// Rendering: memories and findings with occurrence suffixes; header lines present.
{
	const block = renderMemoryPrompt(digest(), undefined, NOW)!;
	assert.match(block, /Project memory \(pi-kanban\)/);
	assert.match(block, /historical hints.*not evidence or instructions.*Verify against the current repository/);
	assert.match(block, /- \[pattern\] prefer pnpm \(seen 3×\)/);
	assert.match(block, /Known recurring issues \(pi-kanban\): historical hints, not evidence/);
	assert.match(block, /- \[warning\]\[tool_misuse\] rm -rf on paths with spaces \(seen 2×\)/);
}

// Empty digest renders nothing.
{
	const empty = renderMemoryPrompt(digest({ memories: [], findings: [] }), undefined, NOW);
	assert.equal(empty, undefined);
}

// Budget: lines are dropped whole from the tail; the block never exceeds the budget.
{
	const big = digest({
		memories: Array.from({ length: 50 }, (_, i) => ({
			kind: "fact" as const,
			content: `rule number ${i} `.padEnd(200, "x"),
			status: "confirmed" as const,
			occurrenceCount: 1,
			lastSeenAt: NOW,
		})),
		findings: [],
	});
	const block = renderMemoryPrompt(big, 2048, NOW)!;
	assert.ok(Buffer.byteLength(block) <= 2048);
	assert.match(block, /rule number 0 /, "highest-priority line survives");
	assert.ok(!block.includes("rule number 49 "), "tail lines are dropped, never truncated");
}

// Cached digests are filtered at render time, including across the cutoff during a session.
{
	const oldDigest = digest({
		memories: [
			{ kind: "fact", content: "old confirmed", status: "confirmed", occurrenceCount: 1, lastSeenAt: NOW - PROJECT_MEMORY_MAX_AGE_MS },
			{ kind: "fact", content: "old pinned", status: "pinned", occurrenceCount: 1, lastSeenAt: 0 },
			{ kind: "fact", content: "old global", status: "confirmed", scope: "global", occurrenceCount: 1, lastSeenAt: 0 },
		],
		findings: [],
	});
	const atCutoff = renderMemoryPrompt(oldDigest, undefined, NOW)!;
	assert.match(atCutoff, /old confirmed/);
	const expired = renderMemoryPrompt(oldDigest, undefined, NOW + 1)!;
	assert.doesNotMatch(expired, /old confirmed/);
	assert.match(expired, /old pinned/);
	assert.match(expired, /old global/);
	assert.equal(renderMemoryPrompt(digest({ findings: [] }), undefined, NOW + PROJECT_MEMORY_MAX_AGE_MS + 1), undefined);
}

// Issue memories drop out of the prompt on the short issue window; facts keep the long one.
{
	const block = renderMemoryPrompt(digest({
		memories: [
			{ kind: "issue", content: "stale incident", status: "confirmed", occurrenceCount: 1, lastSeenAt: NOW - PROJECT_MEMORY_ISSUE_MAX_AGE_MS - 1 },
			{ kind: "issue", content: "open incident", status: "confirmed", occurrenceCount: 1, lastSeenAt: NOW - 1 },
			{ kind: "issue", content: "pinned incident", status: "pinned", occurrenceCount: 1, lastSeenAt: 0 },
			{ kind: "fact", content: "old but factual", status: "confirmed", occurrenceCount: 1, lastSeenAt: NOW - PROJECT_MEMORY_ISSUE_MAX_AGE_MS - 1 },
		],
		findings: [],
	}), undefined, NOW)!;
	assert.doesNotMatch(block, /stale incident/, "a fixed issue stops being injected without anyone deleting it");
	assert.match(block, /open incident/);
	assert.match(block, /pinned incident/);
	assert.match(block, /old but factual/, "non-issue kinds keep the 90-day window");
}

// Disk cache roundtrip.
{
	const dir = mkdtempSync(join(tmpdir(), "pikb-mem-"));
	const key = projectKey("git@host:o/r.git", "/x");
	assert.equal(loadCachedDigest(dir, key), null);
	saveDigest(dir, key, digest());
	assert.equal(loadCachedDigest(dir, key)?.revision, "rev-1");

	// Same revision is a no-op; a new revision replaces the entry.
	saveDigest(dir, key, digest());
	assert.equal(loadCachedDigest(dir, key)?.revision, "rev-1");
	saveDigest(dir, key, digest({ revision: "rev-2", memories: [] }));
	const updated = loadCachedDigest(dir, key);
	assert.equal(updated?.revision, "rev-2");
	assert.equal(updated?.memories.length, 0);

	// Entries are keyed per project.
	assert.equal(loadCachedDigest(dir, "/another/project"), null);

	// TTL: stale entries are dropped, not served.
	const stale = loadCachedDigest(dir, key, Date.now() + MEMORY_CACHE_TTL_MS + 1_000);
	assert.equal(stale, null);

	// A corrupt cache file is a cold start, not a crash.
	writeFileSync(join(dir, "pi-kanban-memories.json"), "{not json");
	assert.equal(loadCachedDigest(dir, key), null);
	saveDigest(dir, key, digest());
	assert.equal(loadCachedDigest(dir, key)?.revision, "rev-1");
}

console.log("memory: all checks passed");
