import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryDigestMessage } from "@pi-kanban/shared";
import { cacheStats, saveDigest } from "../src/memory-cache.js";
import { formatStatus, type KanbanStatusSnapshot } from "../src/status.js";

const NOW = Date.UTC(2025, 0, 1, 12);

function digest(overrides: Partial<MemoryDigestMessage> = {}): MemoryDigestMessage {
	return {
		type: "memory_digest",
		projectId: 7,
		projectName: "pi-kanban",
		revision: "a1b2c3d4e5f6",
		generatedAt: NOW - 12 * 60_000,
		memories: [
			{ kind: "pattern", content: "prefer pnpm", status: "confirmed", occurrenceCount: 3, lastSeenAt: 0 },
			{ kind: "decision", content: "keep gate rules strict", status: "pinned", occurrenceCount: 1, lastSeenAt: 0 },
		],
		findings: [
			{ kind: "tool_misuse", severity: "error", summary: "rm -rf", occurrenceCount: 2, lastSeenAt: 0 },
			{ kind: "context_gap", severity: "info", summary: "docs stale", occurrenceCount: 1, lastSeenAt: 0 },
		],
		...overrides,
	};
}

function snapshot(overrides: Partial<KanbanStatusSnapshot> = {}): KanbanStatusSnapshot {
	return {
		serverUrl: "ws://kanban:8787/agent",
		connected: true,
		queued: 0,
		sessionId: "8f3c1d2e4b5a67890123456789abcdef",
		totalTurns: 12,
		injectedTurns: 10,
		digest: digest(),
		promptBlockBytes: 3200,
		promptBudgetBytes: 4096,
		cacheEntries: [],
		now: NOW,
		...overrides,
	};
}

// Full snapshot: connection, session, digest contents with breakdowns, injection.
{
	const text = formatStatus(snapshot());
	assert.match(text, /connected/);
	assert.match(text, /10\/12 turns injected/);
	assert.match(text, /pi-kanban \(#7\)/);
	assert.match(text, /rev a1b2c3d4e5f6 · 12m old/);
	assert.match(text, /memories    2 injected \(1 pinned, 1 confirmed\)/);
	assert.match(text, /findings    2 \(1 error, 1 info\)/);
	assert.match(text, /injection   active · 3200 \/ 4096 B/);
}

// No digest yet: state is explicit, not a crash or a blank panel.
{
	const text = formatStatus(snapshot({ digest: null, promptBlockBytes: 0 }));
	assert.match(text, /no digest \(fetch pending or server unreachable\)/);
	assert.match(text, /injection   inactive · budget 4096 B/);
}

// Empty digest with a connection problem and queue backlog.
{
	const empty = digest({ memories: [], findings: [] });
	const text = formatStatus(snapshot({ digest: empty, connected: false, queued: 4, promptBlockBytes: 0 }));
	assert.match(text, /disconnected, 4 queued/);
	assert.match(text, /memories    0 injected \(0 pinned, 0 confirmed\)/);
	assert.match(text, /findings    0/);
	assert.match(text, /injection   inactive \(empty digest\) · 0 \/ 4096 B/);
}

// Cache listing: freshest first with age.
{
	const dir = mkdtempSync(join(tmpdir(), "pikb-status-"));
	saveDigest(dir, "git@host:o/r.git", digest({ revision: "fresh00000000" }), NOW - 60_000);
	saveDigest(dir, "/elsewhere", digest({ revision: "stale00000000" }), NOW - 3 * 86_400_000);
	const stats = cacheStats(dir, NOW);
	assert.deepEqual(stats.map((s) => s.revision), ["fresh00000000", "stale00000000"]);
	const text = formatStatus(snapshot({ cacheEntries: stats }));
	assert.match(text, /cache       2 projects/);
	assert.match(text, /git@host:o\/r\.git · rev fresh00000000 · 1m old/);
	assert.match(text, /\/elsewhere · rev stale00000000 · 3d old/);

	// Corrupt cache reads as empty, not a crash.
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "pi-kanban-memories.json"), "{oops");
	assert.deepEqual(cacheStats(dir, NOW), []);
}

// Session-less (pre-session) snapshot still renders.
{
	const text = formatStatus(snapshot({ sessionId: null, totalTurns: 0, injectedTurns: 0 }));
	assert.match(text, /session     none/);
	assert.ok(!text.includes("turns injected"));
}

console.log("status: all checks passed");
