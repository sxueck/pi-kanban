import type { SessionState } from "@pi-kanban/shared";

export type NavIconName = "board" | "approvals" | "history" | "account" | "settings" | "logout";

const NAV_PATHS: Record<NavIconName, React.ReactNode> = {
	board: (
		<>
			<rect x="2.5" y="2.5" width="4.5" height="11" rx="1.2" />
			<rect x="9.75" y="2.5" width="4.5" height="7" rx="1.2" />
		</>
	),
	approvals: (
		<>
			<circle cx="8" cy="8" r="5.5" />
			<path d="M5.6 8.2l1.8 1.8 3.2-3.6" />
		</>
	),
	history: (
		<>
			<circle cx="8" cy="8" r="5.5" />
			<path d="M8 5.2V8l2 1.6" />
		</>
	),
	account: (
		<>
			<circle cx="8" cy="5.4" r="2.6" />
			<path d="M3.2 13.2c.7-2.4 2.6-3.7 4.8-3.7s4.1 1.3 4.8 3.7" />
		</>
	),
	settings: (
		<>
			<circle cx="8" cy="8" r="2" />
			<path d="M8 2.6v1.8M8 11.6v1.8M2.6 8h1.8M11.6 8h1.8M4.2 4.2l1.3 1.3M10.5 10.5l1.3 1.3M11.8 4.2l-1.3 1.3M5.5 10.5l-1.3 1.3" />
		</>
	),
	logout: (
		<>
			<path d="M9.8 3H4.6a1.4 1.4 0 0 0-1.4 1.4v7.2A1.4 1.4 0 0 0 4.6 13h5.2" />
			<path d="M6.8 8h6.4M11.2 5.6 13.2 8l-2 2.4" />
		</>
	),
};

export function NavIcon({ name }: { name: NavIconName }) {
	return (
		<svg className="nav-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			{NAV_PATHS[name]}
		</svg>
	);
}

export function StateIcon({ state }: { state: SessionState }) {
	return (
		<span className={`state-icon icon-${state}`} aria-label={state.replace("_", " ")}>
			<span className="state-mark" />
		</span>
	);
}
