import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryDigestMessage } from "@pi-kanban/shared";
import {
	loadCachedDigest,
	MEMORY_CACHE_TTL_MS,
	projectKey,
	renderMemoryPrompt,
	saveDigest,
} from "../src/memory-cache.js";

function digest(overrides: Partial<MemoryDigestMessage> = {}): MemoryDigestMessage {
	return {
		type: "memory_digest",
		projectId: 1,
		projectName: "p",
		revision: "rev-1",
		generatedAt: 0,
		memories: [{ kind: "pattern", content: "prefer pnpm", status: "confirmed", occurrenceCount: 3, lastSeenAt: 0 }],
		findings: [{ kind: "tool_misuse", severity: "warning", summary: "rm -rf on paths with spaces", occurrenceCount: 2, lastSeenAt: 0 }],
		...overrides,
	};
}

// projectKey prefers the remote so clones at different paths share one entry.
assert.equal(projectKey("git@host:o/r.git", "/any/path"), "git@host:o/r.git");
assert.equal(projectKey(undefined, "/repo/path"), "/repo/path");

// Rendering: memories and findings with occurrence suffixes; header lines present.
{
	const block = renderMemoryPrompt(digest())!;
	assert.match(block, /Project memory \(pi-kanban\)/);
	assert.match(block, /- \[pattern\] prefer pnpm \(seen 3×\)/);
	assert.match(block, /Known recurring issues \(pi-kanban\)/);
	assert.match(block, /- \[warning\]\[tool_misuse\] rm -rf on paths with spaces \(seen 2×\)/);
}

// Empty digest renders nothing.
{
	const empty = renderMemoryPrompt(digest({ memories: [], findings: [] }));
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
			lastSeenAt: 0,
		})),
		findings: [],
	});
	const block = renderMemoryPrompt(big, 2048)!;
	assert.ok(Buffer.byteLength(block) <= 2048);
	assert.match(block, /rule number 0 /, "highest-priority line survives");
	assert.ok(!block.includes("rule number 49 "), "tail lines are dropped, never truncated");
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
