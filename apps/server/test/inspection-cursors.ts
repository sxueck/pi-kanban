import assert from "node:assert/strict";
import {
	advanceSessionCursors,
	mergeSessionCursorDeltas,
	normalizeSessionCursors,
	reduceCursorDelta,
} from "../src/inspector.js";

// normalizeSessionCursors: malformed jsonb round-trips degrade to empty/clean maps.
assert.deepEqual(normalizeSessionCursors(null), {});
assert.deepEqual(normalizeSessionCursors("junk"), {});
assert.deepEqual(normalizeSessionCursors({ s1: "nope", s2: { m: 1.5, t: -3 }, s3: { m: 7 } }), { s3: { m: 7 } });

// reduceCursorDelta: minimum included id per session wins (rows arrive newest-first).
{
	const delta = reduceCursorDelta([
		{ sessionId: "a", id: 30 },
		{ sessionId: "a", id: 12 },
		{ sessionId: "b", id: 5 },
		{ sessionId: "c", id: "not-a-number" },
		{ id: 9 },
	], "m");
	assert.deepEqual(delta, { a: { m: 12 }, b: { m: 5 } });
}

// reduceCursorDelta on tool rows fills the t field.
{
	const delta = reduceCursorDelta([{ sessionId: "a", id: 8 }], "t");
	assert.deepEqual(delta, { a: { t: 8 } });
}

// mergeSessionCursorDeltas: per session/field the minimum wins; disjoint maps union.
{
	const merged = mergeSessionCursorDeltas(
		{ a: { m: 12 }, b: { t: 8 } },
		{ a: { m: 20, t: 4 }, b: { t: 3 } },
	);
	assert.deepEqual(merged, { a: { m: 12, t: 4 }, b: { t: 3 } });
}

// advanceSessionCursors: cursors only move forward, absent fields stay absent.
{
	const prev = { a: { m: 10, t: 2 }, kept: { m: 1 } };
	const next = advanceSessionCursors(prev, { a: { m: 12 }, b: { t: 6 } });
	assert.deepEqual(next, { a: { m: 12, t: 2 }, kept: { m: 1 }, b: { t: 6 } });
	// A smaller delta cannot rewind an existing cursor.
	assert.deepEqual(advanceSessionCursors({ a: { m: 12 } }, { a: { m: 5 } }), { a: { m: 12 } });
	// Sessions present in neither map are untouched.
	assert.deepEqual(advanceSessionCursors({}, {}), {});
}
