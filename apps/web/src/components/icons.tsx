import type { SessionState } from "@pi-kanban/shared";

export function StateIcon({ state }: { state: SessionState }) {
	return (
		<span className={`state-icon icon-${state}`} aria-label={state.replace("_", " ")}>
			<span className="state-mark" />
		</span>
	);
}
