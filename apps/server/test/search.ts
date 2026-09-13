import assert from "node:assert/strict";
import { tokenizeForSearch } from "@pi-kanban/shared";
import {
	aggregateSessionHits,
	buildSnippet,
	FIELD_WEIGHTS,
	parseSearchQuery,
	scoreRows,
	searchTokensFor,
	type SessionRowHit,
} from "../src/search.js";

// --- shared tokenizer ---------------------------------------------------------

// CJK runs become bigrams; short runs stay whole.
assert.deepEqual(tokenizeForSearch("决策记录"), ["决策", "策记", "记录"]);
assert.deepEqual(tokenizeForSearch("ok"), ["ok"]);
// Mixed text keeps word tokens and bigrams apart; hyphens split.
assert.deepEqual(tokenizeForSearch("BM25 检索 zod-error"), ["bm25", "检索", "zod", "error"]);
// NFKC + case folding.
assert.deepEqual(tokenizeForSearch("ＡＢＣ ｔｅｓｔ"), ["abc", "test"]);
// Whitespace-only and empty queries produce nothing.
assert.deepEqual(tokenizeForSearch("   "), []);
// Blank stored text uses an empty array rather than null, so boot-time backfill
// marks it complete instead of selecting it forever.
assert.deepEqual(searchTokensFor("   "), []);
assert.equal(searchTokensFor(null), null);

// --- query parsing ------------------------------------------------------------

assert.deepEqual(parseSearchQuery("决策 memory"), ["决策", "memory"]);
// Duplicates collapse.
assert.deepEqual(parseSearchQuery("test test"), ["test"]);

// --- BM25 scoring over stored token multisets ---------------------------------

// A row matching more query tokens outranks a single-token match.
{
	const rows = [
		{ data: "both", tokens: ["zod", "error", "extra"], weight: 1 },
		{ data: "one", tokens: ["zod"], weight: 1 },
		{ data: "none", tokens: ["other"], weight: 1 },
	];
	const scored = scoreRows(rows, ["zod", "error"]);
	assert.equal(scored.length, 2);
	const byData = new Map(scored.map(({ data, score }) => [data, score]));
	assert.ok((byData.get("both") ?? 0) > (byData.get("one") ?? 0));
}

// Field weight decides between equally-matching sources (scoreRows itself
// stays order-free; ranking happens in aggregateSessionHits).
{
	const rows = [
		{ data: "excerpt", tokens: ["deploy"], weight: FIELD_WEIGHTS.messageExcerpt },
		{ data: "prompt", tokens: ["deploy"], weight: FIELD_WEIGHTS.turnPrompt },
	];
	const scored = scoreRows(rows, ["deploy"]);
	const byData = new Map(scored.map(({ data, score }) => [data, score]));
	assert.ok((byData.get("prompt") ?? 0) > (byData.get("excerpt") ?? 0));
}

// Repeated tokens raise the score (term frequency component).
{
	const rows = [
		{ data: "once", tokens: ["cache"], weight: 1 },
		{ data: "often", tokens: ["cache", "cache", "cache"], weight: 1 },
	];
	const byData = new Map(scoreRows(rows, ["cache"]).map(({ data, score }) => [data, score]));
	assert.ok((byData.get("often") ?? 0) > (byData.get("once") ?? 0));
}

// Null tokens never match.
assert.equal(scoreRows([{ data: 1, tokens: null, weight: 1 }], ["x"]).length, 0);

// --- snippets ------------------------------------------------------------------

assert.equal(buildSnippet("alpha beta gamma", ["beta"]), "alpha beta gamma");
// Snippet centers on the match for long text.
{
	const text = `${"x".repeat(300)} needle ${"y".repeat(300)}`;
	const snippet = buildSnippet(text, ["needle"]);
	assert.ok(snippet.includes("needle"));
	assert.ok(snippet.length <= 261);
}
assert.equal(buildSnippet(null, ["a"]), undefined);
assert.equal(buildSnippet("   ", ["a"]), undefined);

// --- session aggregation --------------------------------------------------------

const now = Date.now();
const hits: SessionRowHit[] = [
	{ sessionId: "s1", title: null, projectId: 1, projectName: "p1", matchedAt: now, turnPosition: 2, text: "cache strategy", score: 3 },
	{ sessionId: "s1", title: null, projectId: 1, projectName: "p1", matchedAt: now - 1, turnPosition: null, text: "cache again", score: 2 },
	{ sessionId: "s2", title: "other", projectId: 2, projectName: "p2", matchedAt: now - 2, turnPosition: null, text: "cache mention", score: 1 },
];
{
	const aggregated = aggregateSessionHits(hits, ["cache"], 10);
	assert.equal(aggregated.length, 2);
	assert.equal(aggregated[0].sessionId, "s1");
	// Best score plus a bonus for the extra hit.
	assert.ok(Math.abs(aggregated[0].score - 3.25) < 1e-9);
	assert.equal(aggregated[0].snippet, "cache strategy");
	// Limit truncates.
	assert.equal(aggregateSessionHits(hits, ["cache"], 1).length, 1);
}

console.log("search: all checks passed");
