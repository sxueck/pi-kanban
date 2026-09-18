import assert from "node:assert/strict";
import type { MemoryDigestMessage } from "@pi-kanban/shared";
import { formatTaste } from "../src/taste.js";

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

// /taste right after (re)load: block rendered but no agent turn yet — not "inactive".
assert.match(
	formatTaste({ digest: digest(), totalTurns: 0, injectedTurns: 0, promptBlockBytes: 3930, promptBudgetBytes: 4096, now: 0 }),
	/armed · no turns yet · 3930 \/ 4096 B/,
);
