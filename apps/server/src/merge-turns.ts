import type { TurnDTO } from "@pi-kanban/shared";
import type { turns } from "./db/schema.js";

function normalizePrompt(prompt: string): string {
	return prompt.replace(/\s+/g, " ").trim();
}

/**
 * Collapse adjacent, whitespace-equivalent prompts for display while retaining
 * every source position so messages and tool calls remain traceable.
 */
export function mergeTurns(rows: Array<typeof turns.$inferSelect>): TurnDTO[] {
	const out: TurnDTO[] = [];
	for (const t of rows) {
		const prev = out.at(-1);
		if (prev && normalizePrompt(prev.prompt) === normalizePrompt(t.prompt)) {
			prev.positions?.push(t.position);
			prev.steps = (prev.steps ?? 1) + 1;
			if (t.state === "running") prev.state = "running";
			if (t.endedAt) prev.endedAt = t.endedAt.getTime();
			continue;
		}
		out.push({
			position: t.position,
			positions: [t.position],
			prompt: t.prompt,
			state: t.state as "running" | "done",
			startedAt: t.startedAt.getTime(),
			endedAt: t.endedAt?.getTime(),
			steps: 1,
		});
	}
	return out;
}

export function displayTurnPositions(turns: TurnDTO[]): Map<number, number> {
	const positions = new Map<number, number>();
	for (const turn of turns) {
		for (const position of turn.positions ?? [turn.position]) positions.set(position, turn.position);
	}
	return positions;
}
