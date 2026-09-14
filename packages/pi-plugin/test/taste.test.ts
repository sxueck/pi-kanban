import assert from "node:assert/strict";
import type { MemoryDigestMessage } from "@pi-kanban/shared";
import { diffDigests, formatTaste, formatTasteNotice } from "../src/taste.js";

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

// Unchanged revision → nothing to show (same no-op rule as the disk cache).
assert.equal(diffDigests(digest(), digest()), null);

// Cold start: no previous digest, everything is new.
{
	const diff = diffDigests(null, digest())!;
	assert.equal(diff.coldStart, true);
	assert.equal(diff.learned.length, 1);
	assert.equal(diff.newFindings.length, 1);
}

// Learned / reinforced / retired are keyed by scope+kind+content.
{
	const next = digest({
		revision: "rev-2",
		memories: [
			{ kind: "pattern", content: "prefer pnpm", status: "confirmed", occurrenceCount: 5, lastSeenAt: 1 },
			{ kind: "decision", content: "keep the gate local-first", status: "confirmed", occurrenceCount: 1, lastSeenAt: 1 },
		],
		findings: [],
	});
	const diff = diffDigests(digest(), next)!;
	assert.equal(diff.coldStart, false);
	assert.deepEqual(diff.learned.map((entry) => entry.content), ["keep the gate local-first"]);
	assert.deepEqual(diff.reinforced, [{ entry: next.memories[0]!, previousOccurrenceCount: 3 }]);
	assert.deepEqual(diff.retired, []);
	assert.deepEqual(diff.newFindings, []);
}

// A memory absent from the next digest is reported as retired; a removed
// finding is not (retired tracks memories only — budget churn stays quiet).
{
	const diff = diffDigests(digest(), digest({ revision: "rev-2", memories: [] }))!;
	assert.deepEqual(diff.retired.map((entry) => entry.content), ["prefer pnpm"]);
}

// Occurrence decreases are not reinforcements.
{
	const next = digest({ revision: "rev-2", memories: [{ kind: "pattern", content: "prefer pnpm", status: "confirmed", occurrenceCount: 2, lastSeenAt: 1 }] });
	assert.deepEqual(diffDigests(digest(), next)!.reinforced, []);
}

// Notice: cold start is a single line pointing at /taste.
assert.match(formatTasteNotice(diffDigests(null, digest())!), /^pi-kanban taste: 1 memory, 1 finding mined/);

// Notice: header plus capped per-entry lines; /taste hint on the tail.
{
	const diff = diffDigests(digest({ memories: [], findings: [] }), digest({
		revision: "rev-2",
		memories: Array.from({ length: 5 }, (_, i) => ({
			kind: "decision" as const,
			content: `rule ${i}`,
			status: "confirmed" as const,
			occurrenceCount: 1,
			lastSeenAt: 0,
		})),
	}))!;
	const notice = formatTasteNotice(diff);
	const lines = notice.split("\n");
	assert.match(lines[0]!, /^pi-kanban taste updated: \+5 learned/);
	assert.equal(lines.filter((line) => line.startsWith("  + ")).length, 3);
	assert.match(lines.at(-1)!, /2 more — \/taste for the full picture/);
}

// /taste: full digest renders sections, stats and the advisory footer.
{
	const text = formatTaste({
		digest: digest({
			memories: [
				{ kind: "principle", content: "delete over add", status: "pinned", occurrenceCount: 2, lastSeenAt: 0, scope: "global" },
				{ kind: "pattern", content: "prefer pnpm", status: "confirmed", occurrenceCount: 3, lastSeenAt: 0 },
			],
		}),
		totalTurns: 4,
		injectedTurns: 3,
		promptBlockBytes: 512,
		promptBudgetBytes: 4096,
		now: 60_000,
	});
	assert.match(text, /^pi-kanban taste — p \(#1\) · rev rev-1 · 1m old/);
	assert.match(text, /product-wide principles \(1\)/);
	assert.match(text, /• \[principle\] \(pinned · seen 2×\) delete over add/);
	assert.match(text, /project memories \(1\)/);
	assert.match(text, /recurring findings \(1\)/);
	assert.match(text, /3\/4 turns · 512 \/ 4096 B · advisory, display-only/);
}

// /taste without a digest explains how to get one.
assert.match(formatTaste({ digest: null, totalTurns: 0, injectedTurns: 0, promptBlockBytes: 0, promptBudgetBytes: 4096, now: 0 }), /no digest yet/);
