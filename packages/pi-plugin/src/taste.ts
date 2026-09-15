import type { MemoryDigestEntry, MemoryDigestMessage } from "@pi-kanban/shared";
import { truncate } from "@pi-kanban/shared";
import { relativeAge } from "./status.js";

/** Lines shown per category in the digest-change notice; the rest is summarized. */
const NOTICE_LEARNED_LINES = 3;
const NOTICE_REINFORCED_LINES = 2;
const NOTICE_FINDING_LINES = 2;
const NOTICE_CONTENT_CHARS = 80;

/** Result of comparing a digest against the previously cached one. */
export interface DigestDiff {
	/** True when no previous digest was cached (fresh project or expired cache). */
	coldStart: boolean;
	learned: MemoryDigestEntry[];
	reinforced: Array<{ entry: MemoryDigestEntry; previousOccurrenceCount: number }>;
	/** Present before, absent now — superseded, archived, or fallen out of the digest budget. */
	retired: MemoryDigestEntry[];
	newFindings: MemoryDigestMessage["findings"];
}

function memoryKey(entry: MemoryDigestEntry): string {
	return `${entry.scope ?? "project"}|${entry.kind}|${entry.content}`;
}

function findingKey(finding: MemoryDigestMessage["findings"][number]): string {
	return `${finding.kind}|${finding.severity}|${finding.summary}`;
}

/**
 * Compares a digest against the previously cached one. Entries are keyed by
 * scope+kind+content, so a reworded memory counts as learned + retired. Returns
 * null when the revision is unchanged — the same no-op rule the disk cache uses.
 */
export function diffDigests(previous: MemoryDigestMessage | null, next: MemoryDigestMessage): DigestDiff | null {
	if (previous && previous.revision === next.revision) return null;
	const prevMemories = new Map((previous?.memories ?? []).map((entry) => [memoryKey(entry), entry]));
	const prevFindings = new Set((previous?.findings ?? []).map(findingKey));
	const learned: MemoryDigestEntry[] = [];
	const reinforced: DigestDiff["reinforced"] = [];
	const retired: MemoryDigestEntry[] = [];
	for (const [key, entry] of prevMemories) {
		if (!next.memories.some((current) => memoryKey(current) === key)) retired.push(entry);
	}
	for (const entry of next.memories) {
		const prev = prevMemories.get(memoryKey(entry));
		if (!prev) learned.push(entry);
		else if (entry.occurrenceCount > prev.occurrenceCount) {
			reinforced.push({ entry, previousOccurrenceCount: prev.occurrenceCount });
		}
	}
	const newFindings = next.findings.filter((finding) => !prevFindings.has(findingKey(finding)));
	return { coldStart: previous == null, learned, reinforced, retired, newFindings };
}

/**
 * Compact transcript notice for a digest change: one header line plus the few
 * most interesting entries, capped so a busy inspection stays a glance, not a
 * dump. Display-only — these lines never enter LLM context.
 */
export function formatTasteNotice(diff: DigestDiff): string {
	if (diff.coldStart) {
		const parts: string[] = [];
		if (diff.learned.length > 0) parts.push(`${diff.learned.length} memor${diff.learned.length === 1 ? "y" : "ies"}`);
		if (diff.newFindings.length > 0) parts.push(`${diff.newFindings.length} finding${diff.newFindings.length === 1 ? "" : "s"}`);
		if (parts.length === 0) return "pi-kanban taste: nothing mined for this project yet";
		return `pi-kanban taste: ${parts.join(", ")} mined for this project — run /taste to view`;
	}
	const summary = [
		diff.learned.length > 0 ? `+${diff.learned.length} learned` : null,
		diff.reinforced.length > 0 ? `${diff.reinforced.length} reinforced` : null,
		diff.retired.length > 0 ? `${diff.retired.length} no longer injected` : null,
	].filter(Boolean).join(" · ");
	const lines = [`pi-kanban taste updated: ${summary || "revision changed"}`];
	for (const entry of diff.learned.slice(0, NOTICE_LEARNED_LINES)) {
		lines.push(`  + [${entry.kind}] ${truncate(entry.content, NOTICE_CONTENT_CHARS)}${occurrence(entry.occurrenceCount)}`);
	}
	for (const { entry, previousOccurrenceCount } of diff.reinforced.slice(0, NOTICE_REINFORCED_LINES)) {
		lines.push(`  ~ [${entry.kind}] ${truncate(entry.content, NOTICE_CONTENT_CHARS)} (seen ${previousOccurrenceCount}× → ${entry.occurrenceCount}×)`);
	}
	for (const finding of diff.newFindings.slice(0, NOTICE_FINDING_LINES)) {
		lines.push(`  ! [${finding.severity}] ${truncate(finding.summary, NOTICE_CONTENT_CHARS)}${occurrence(finding.occurrenceCount)}`);
	}
	const shown = diff.learned.length + diff.reinforced.length + diff.newFindings.length;
	const hidden = diff.learned.length - Math.min(diff.learned.length, NOTICE_LEARNED_LINES)
		+ diff.reinforced.length - Math.min(diff.reinforced.length, NOTICE_REINFORCED_LINES)
		+ diff.newFindings.length - Math.min(diff.newFindings.length, NOTICE_FINDING_LINES);
	if (hidden > 0) lines.push(`  … ${hidden} more — /taste for the full picture`);
	else if (shown > 0) lines.push("  /taste for the full picture");
	return lines.join("\n");
}

/** Everything /taste reports, collected at command time. */
export interface TasteSnapshot {
	digest: MemoryDigestMessage | null;
	totalTurns: number;
	injectedTurns: number;
	promptBlockBytes: number;
	promptBudgetBytes: number;
	now: number;
}

/** Full display of the mined data for the /taste command, styled after /kanban-status. */
export function formatTaste(snapshot: TasteSnapshot): string {
	const lines: string[] = [];
	const digest = snapshot.digest;
	if (!digest) {
		lines.push("pi-kanban taste");
		lines.push("  no digest yet — inspections run on the schedule set in the dashboard;");
		lines.push("  once one completes, mined memories are injected here automatically");
		return lines.join("\n");
	}
	lines.push(`pi-kanban taste — ${digest.projectName} (#${digest.projectId}) · rev ${digest.revision} · ${relativeAge(digest.generatedAt, snapshot.now)}`);
	const globalMemories = digest.memories.filter((memory) => memory.scope === "global");
	const projectMemories = digest.memories.filter((memory) => memory.scope !== "global");
	if (globalMemories.length > 0) {
		lines.push(`  product-wide principles (${globalMemories.length})`);
		for (const memory of globalMemories) lines.push(`    • [${memory.kind}] (${memory.status}${occurrence(memory.occurrenceCount)}) ${truncate(memory.content, 160)}`);
	}
	if (projectMemories.length > 0) {
		lines.push(`  project memories (${projectMemories.length})`);
		for (const memory of projectMemories) lines.push(`    • [${memory.kind}] (${memory.status}${occurrence(memory.occurrenceCount)}) ${truncate(memory.content, 160)}`);
	}
	if (digest.findings.length > 0) {
		lines.push(`  recurring findings (${digest.findings.length})`);
		for (const finding of digest.findings) {
			lines.push(`    • [${finding.severity}][${finding.kind}] ${truncate(finding.summary, 140)}${occurrence(finding.occurrenceCount)} · ${relativeAge(finding.lastSeenAt, snapshot.now)}`);
		}
	}
	if (digest.memories.length === 0 && digest.findings.length === 0) {
		lines.push("  nothing mined yet");
	}
	const injection = snapshot.totalTurns > 0 ? `${snapshot.injectedTurns}/${snapshot.totalTurns} turns` : "inactive";
	lines.push(`  injection  ${injection} · ${snapshot.promptBlockBytes} / ${snapshot.promptBudgetBytes} B · advisory, display-only`);
	return lines.join("\n");
}

function occurrence(count: number): string {
	return count > 1 ? ` · seen ${count}×` : "";
}
