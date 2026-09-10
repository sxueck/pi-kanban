import type { MemoryDigestMessage } from "@pi-kanban/shared";

/** Everything /kanban-status reports, collected by the extension factory. */
export interface KanbanStatusSnapshot {
	serverUrl: string;
	connected: boolean;
	/** Upstream messages queued while disconnected. */
	queued: number;
	sessionId: string | null;
	totalTurns: number;
	injectedTurns: number;
	digest: MemoryDigestMessage | null;
	/** Bytes of the block currently appended to each turn's system prompt. */
	promptBlockBytes: number;
	promptBudgetBytes: number;
	/** Cache entries for every project, freshest first. */
	cacheEntries: Array<{ key: string; revision: string; ageMs: number }>;
	now: number;
}

export function formatStatus(snapshot: KanbanStatusSnapshot): string {
	const lines: string[] = [];
	lines.push("pi-kanban status");
	lines.push(`  server      ${snapshot.serverUrl} — ${snapshot.connected ? "connected" : "disconnected"}${snapshot.queued > 0 ? `, ${snapshot.queued} queued` : ""}`);
	if (snapshot.sessionId) {
		const injection = snapshot.totalTurns > 0
			? ` · ${snapshot.injectedTurns}/${snapshot.totalTurns} turns injected`
			: "";
		lines.push(`  session     ${short(snapshot.sessionId)}${injection}`);
	} else {
		lines.push("  session     none");
	}

	const digest = snapshot.digest;
	if (!digest) {
		lines.push("  project     no digest (fetch pending or server unreachable)");
		lines.push(`  injection   inactive · budget ${snapshot.promptBudgetBytes} B`);
	} else {
		lines.push(`  project     ${digest.projectName} (#${digest.projectId})`);
		lines.push(`  digest      rev ${digest.revision} · ${relativeAge(digest.generatedAt, snapshot.now)}`);
		const pinned = digest.memories.filter((m) => m.status === "pinned").length;
		const confirmed = digest.memories.length - pinned;
		lines.push(`  memories    ${digest.memories.length} injected (${pinned} pinned, ${confirmed} confirmed)`);
		lines.push(`  findings    ${findingSummary(digest.findings)}`);
		const active = snapshot.promptBlockBytes > 0;
		lines.push(`  injection   ${active ? "active" : "inactive (empty digest)"} · ${snapshot.promptBlockBytes} / ${snapshot.promptBudgetBytes} B`);
	}

	if (snapshot.cacheEntries.length > 0) {
		lines.push(`  cache       ${snapshot.cacheEntries.length} project${snapshot.cacheEntries.length === 1 ? "" : "s"}`);
		for (const entry of snapshot.cacheEntries) {
			lines.push(`    ${entry.key} · rev ${entry.revision} · ${relativeAge(snapshot.now - entry.ageMs, snapshot.now)}`);
		}
	} else {
		lines.push("  cache       empty");
	}
	return lines.join("\n");
}

function findingSummary(findings: MemoryDigestMessage["findings"]): string {
	const counts = { error: 0, warning: 0, info: 0 };
	for (const finding of findings) {
		if (finding.severity === "error") counts.error++;
		else if (finding.severity === "warning") counts.warning++;
		else if (finding.severity === "info") counts.info++;
	}
	const parts: string[] = [];
	if (counts.error > 0) parts.push(`${counts.error} error`);
	if (counts.warning > 0) parts.push(`${counts.warning} warning`);
	if (counts.info > 0) parts.push(`${counts.info} info`);
	return `${findings.length}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}

function relativeAge(then: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - then) / 1000));
	if (seconds < 60) return `${seconds}s old`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m old`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h old`;
	return `${Math.round(hours / 24)}d old`;
}

function short(id: string): string {
	return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}
