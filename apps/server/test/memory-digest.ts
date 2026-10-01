import assert from "node:assert/strict";
import { PROJECT_MEMORY_ISSUE_MAX_AGE_MS, PROJECT_MEMORY_MAX_AGE_MS } from "@pi-kanban/shared";
import {
	buildDigestPayload,
	DIGEST_MEMORY_LIMIT,
	DigestFindingRow,
	DigestMemoryRow,
	MAX_DIGEST_BYTES,
} from "../src/memory-digest.js";

const NOW = Date.UTC(2025, 0, 1);

function memory(status: string, occurrenceCount = 1, ageDays = 0, content = `rule-${status}`): DigestMemoryRow {
	return { kind: "pattern", content, status, occurrenceCount, lastSeenAt: NOW - ageDays * 86_400_000 };
}

function finding(severity: string, ageDays = 0, summary = `issue-${severity}`): DigestFindingRow {
	return { kind: "tool_misuse", severity, summary, occurrenceCount: 1, lastSeenAt: NOW - ageDays * 86_400_000 };
}

// Ordering: pinned before confirmed, then recurrence, then recency.
{
	const payload = buildDigestPayload("p", [
		memory("confirmed", 1, 9, "old-single"),
		memory("confirmed", 3, 1, "hot"),
		memory("pinned", 1, 9, "pinned"),
		memory("confirmed", 3, 0, "hot-fresh"),
	], [], [], NOW);
	assert.deepEqual(payload.memories.map((m) => m.content), ["pinned", "hot-fresh", "hot", "old-single"]);
}

// Candidate and archived memories are never injected (same rule as reference-rules export).
{
	const payload = buildDigestPayload("p", [memory("candidate"), memory("archived")], [], [], NOW);
	assert.equal(payload.memories.length, 0);
	assert.notEqual(payload.revision, "");
}

// Only confirmed project memories age out; pinned and global memories remain.
{
	const cutoffDays = PROJECT_MEMORY_MAX_AGE_MS / 86_400_000;
	const payload = buildDigestPayload("p", [
		memory("confirmed", 1, cutoffDays, "boundary"),
		memory("confirmed", 1, cutoffDays + 1, "old"),
		memory("pinned", 1, cutoffDays + 1, "old-pinned"),
	], [], [memory("confirmed", 1, cutoffDays + 1, "old-global")], NOW);
	assert.deepEqual(payload.memories.map((m) => m.content), ["old-global", "old-pinned", "boundary"]);
	const later = buildDigestPayload("p", [memory("confirmed", 1, cutoffDays, "boundary")], [], [], NOW + 1);
	assert.equal(later.memories.length, 0, "the cutoff is inclusive and expires after one millisecond");
}

// Issue memories age out fastest: a fixed incident stops being re-evidenced,
// so it leaves the prompt at 14 days while other kinds keep the 90-day window.
{
	const issueCutoffDays = PROJECT_MEMORY_ISSUE_MAX_AGE_MS / 86_400_000;
	const issue = (content: string, ageDays: number, status = "confirmed") => ({
		kind: "issue", content, status, occurrenceCount: 1, lastSeenAt: NOW - ageDays * 86_400_000,
	});
	const payload = buildDigestPayload("p", [
		issue("stale-issue", issueCutoffDays + 1),
		issue("fresh-issue", 1),
		issue("old-pinned-issue", issueCutoffDays + 30, "pinned"),
		memory("confirmed", 1, issueCutoffDays + 1, "old-fact-still-current"),
	], [], [issue("old-global-issue", issueCutoffDays + 30)], NOW);
	assert.deepEqual(payload.memories.map((m) => m.content), [
		"old-global-issue", "old-pinned-issue", "fresh-issue", "old-fact-still-current",
	]);
}

// Findings order by severity, then recency.
{
	const payload = buildDigestPayload("p", [], [
		finding("info", 0),
		finding("warning", 0),
		finding("error", 5),
		finding("error", 1),
	]);
	assert.deepEqual(payload.findings.map((f) => f.summary), ["issue-error", "issue-error", "issue-warning", "issue-info"]);
}

// Item caps: 24 memories, 8 findings.
{
	const memories = Array.from({ length: 30 }, (_, i) => memory("confirmed", 30 - i, 0, `m${i}`));
	const findings = Array.from({ length: 12 }, (_, i) => finding("info", i, `f${i}`));
	const payload = buildDigestPayload("p", memories, findings, [], NOW);
	assert.equal(payload.memories.length, DIGEST_MEMORY_LIMIT);
	assert.equal(payload.findings.length, 8);
	assert.equal(payload.memories[0].content, "m0");
}

// Long content is truncated per item (whole-item JSON is never cut mid-string).
{
	const payload = buildDigestPayload("p", [memory("confirmed", 1, 0, "x".repeat(1000))], [], [], NOW);
	const content = payload.memories[0].content;
	assert.ok(content.startsWith("x".repeat(50)) && content.length < 1000, "per-item truncation keeps a bounded prefix");
	assert.match(content, /\[\+\d+ chars\]$/, "truncation is announced, not silent");
}

// The digest cap matches the ingest-side content cap, so a stored memory is
// delivered whole instead of being cut mid-sentence.
{
	const whole = memory("confirmed", 1, 0, "z".repeat(600));
	const payload = buildDigestPayload("p", [whole], [], [], NOW);
	assert.equal(payload.memories[0].content.length, 600, "max-length stored content survives untouched");
	assert.doesNotMatch(payload.memories[0].content, /\[\+\d+ chars\]$/);
}

// Byte budget: items are dropped whole; the serialized digest never exceeds MAX_DIGEST_BYTES.
{
	const huge = Array.from({ length: 50 }, (_, i) => memory("confirmed", 1000 - i, 0, "y".repeat(150)));
	const payload = buildDigestPayload("p", huge, [], [], NOW);
	const serialized = JSON.stringify(payload);
	assert.ok(serialized.length <= MAX_DIGEST_BYTES + 100, "digest must respect the byte budget");
	assert.ok(payload.memories.length > 0 && payload.memories.length < 50, "items past the budget are dropped, not squeezed in");
	assert.ok(payload.memories.every((m) => m.content === "y".repeat(150)), "surviving items are whole, never cut mid-item");
}

// Revision covers content (projectName + entries) but not generatedAt.
{
	const rows = [memory("pinned", 2)];
	const a = buildDigestPayload("p", rows, [], [], NOW);
	const b = buildDigestPayload("p", rows, [], [], NOW + 5_000);
	assert.equal(a.revision, b.revision);
	const changed = buildDigestPayload("p", [memory("pinned", 3)], [], [], NOW);
	assert.notEqual(a.revision, changed.revision);
	const renamed = buildDigestPayload("other", rows, [], [], NOW);
	assert.notEqual(a.revision, renamed.revision);
}

console.log("memory-digest: all checks passed");
