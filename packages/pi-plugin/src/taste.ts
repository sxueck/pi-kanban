import type { MemoryDigestMessage } from "@pi-kanban/shared";
import { truncate } from "@pi-kanban/shared";
import { relativeAge } from "./status.js";

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
	// "armed" = block rendered but no agent turn has started since (re)load, so
	// there is no N/M turn ratio to show — same block /kanban-status calls active.
	const injection = snapshot.totalTurns > 0
		? `${snapshot.injectedTurns}/${snapshot.totalTurns} turns`
		: snapshot.promptBlockBytes > 0 ? "armed · no turns yet" : "inactive";
	lines.push(`  injection  ${injection} · ${snapshot.promptBlockBytes} / ${snapshot.promptBudgetBytes} B · advisory, display-only`);
	return lines.join("\n");
}

function occurrence(count: number): string {
	return count > 1 ? ` · seen ${count}×` : "";
}
