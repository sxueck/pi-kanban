import assert from "node:assert/strict";
import { displayTurnPositions, mergeTurns } from "../src/merge-turns.js";

type Row = Parameters<typeof mergeTurns>[0][number];

function row(position: number, prompt: string, state = "done", start = 0, end?: number): Row {
	return {
		id: position,
		sessionId: "s1",
		position,
		prompt,
		state,
		startedAt: new Date(start),
		endedAt: end != null ? new Date(end) : null,
	} as Row;
}

// legacy per-step rows collapse into one logical turn
const legacy = mergeTurns([
	row(1, "fix the bug", "done", 100, 200),
	row(2, "fix the bug", "done", 200, 300),
	row(3, "fix the bug", "running", 300),
]);
assert.equal(legacy.length, 1);
assert.equal(legacy[0].steps, 3);
assert.equal(legacy[0].state, "running"); // any running step keeps the turn running
assert.equal(legacy[0].startedAt, 100);
assert.deepEqual(legacy[0].positions, [1, 2, 3]);
assert.deepEqual([...displayTurnPositions(legacy)], [
	[1, 1],
	[2, 1],
	[3, 1],
]);

// whitespace-only changes are the same displayed prompt
const whitespace = mergeTurns([
	row(1, "review\nlatest commit", "done", 0, 1),
	row(2, "review  latest   commit", "done", 2, 3),
]);
assert.equal(whitespace.length, 1);
assert.deepEqual(whitespace[0].positions, [1, 2]);

// distinct prompts stay separate
const mixed = mergeTurns([row(1, "a", "done", 0, 1), row(2, "b", "done", 2, 3)]);
assert.equal(mixed.length, 2);
assert.deepEqual(
	mixed.map((t) => t.steps),
	[1, 1],
);

// empty input
assert.deepEqual(mergeTurns([]), []);

console.log("merge-turns: all checks passed");
