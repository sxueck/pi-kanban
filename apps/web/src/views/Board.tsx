import { Link } from "react-router-dom";
import { useState } from "react";
import type { BoardSession, DailyStatDTO, LifetimeStatDTO, RecentSessionDTO, SessionState } from "@pi-kanban/shared";
import { fmtCost, fmtElapsed, useResource } from "../api.js";
import { useI18n } from "../i18n.js";
import type { MsgKey } from "../i18n.js";
import { StateIcon } from "../components/icons.js";
import { EmptyBoardIllustration } from "../components/illustrations.js";

const SECTION_ORDER: Array<{ state: SessionState }> = [
	{ state: "waiting_approval" },
	{ state: "running" },
	{ state: "idle" },
	{ state: "offline" },
];

interface BoardStats {
	running: number;
	waiting: number;
	idle: number;
	projects: number;
}

function groupByState(sessions: BoardSession[]): Map<SessionState, BoardSession[]> {
	const byState = new Map<SessionState, BoardSession[]>();
	for (const s of sessions) {
		const list = byState.get(s.state) ?? [];
		list.push(s);
		byState.set(s.state, list);
	}
	return byState;
}

function boardStats(sessions: BoardSession[], byState: Map<SessionState, BoardSession[]>): BoardStats {
	const projects = new Set<string>();
	for (const s of sessions) {
		projects.add(s.projectName);
	}
	return {
		running: byState.get("running")?.length ?? 0,
		waiting: byState.get("waiting_approval")?.length ?? 0,
		idle: byState.get("idle")?.length ?? 0,
		projects: projects.size,
	};
}

export function Board() {
	const { t } = useI18n();
	const { data, error, loading } = useResource<BoardSession[]>("/api/board");
	const { data: recent, error: recentError } = useResource<RecentSessionDTO[]>("/api/sessions/recent");
	const { data: lifetime, error: lifetimeError } = useResource<LifetimeStatDTO>("/api/stats/total");
	const [query, setQuery] = useState("");
	const [stateFilter, setStateFilter] = useState<SessionState | "all">("all");
	if (error || recentError || lifetimeError) return <div className="error">{String(error ?? recentError ?? lifetimeError)}</div>;
	if (loading && !data) return <div className="empty">loading…</div>;

	const sessions = data ?? [];
	const byState = groupByState(sessions);
	const stats = boardStats(sessions, byState);
	const needle = query.trim().toLowerCase();
	const { visibleByState, recentFiltered, total } = applyFilters(sessions, recent, needle, stateFilter);
	const filtersActive = needle !== "" || stateFilter !== "all";
	const chips: Array<{ value: SessionState | "all"; label: string; count: number }> = [
		{
			value: "all",
			label: t("board.filterAll"),
			count: [...visibleByState.values()].reduce((n, list) => n + list.length, 0),
		},
		...SECTION_ORDER.map(({ state }) => ({
			value: state,
			label: t(`state.${state}` as MsgKey),
			count: visibleByState.get(state)?.length ?? 0,
		})),
	];

	return (
		<div className="board-layout">
			<div className="board-main">
				<section className="board-hero">
					<div className="hero-main">
						<span className="hero-label">{t("hero.label")}</span>
						<strong className="hero-value">{stats.running}</strong>
						{stats.waiting > 0 && (
							<Link className="hero-cta" to="/approvals">
								{t("hero.review", { n: stats.waiting })} →
							</Link>
						)}
					</div>
					<div className="hero-tiles">
						<HeroTile label={t("hero.pending")} value={stats.waiting} />
						<HeroTile label={t("hero.idle")} value={stats.idle} />
						<HeroTile label={t("hero.projects")} value={stats.projects} />
						<HeroTile label={t("hero.totalProjects")} value={lifetime != null ? lifetime.totalProjects : "…"} />
						<HeroTile label={t("hero.totalSessions")} value={lifetime != null ? lifetime.totalSessions : "…"} />
						<HeroTile label={t("hero.cost")} value={lifetime != null ? fmtCost(lifetime.totalCostUsd) : "…"} />
					</div>
				</section>
				<BoardToolbar
					query={query}
					onQuery={setQuery}
					stateFilter={stateFilter}
					onStateFilter={setStateFilter}
					chips={chips}
				/>
				{(recentFiltered.length > 0 || !filtersActive) && (
					<section className="board-section recent-section">
						<header>
							<h2>{t("board.recent")}</h2>
						</header>
						{recentFiltered.length === 0 ? (
							<p className="muted">{t("board.noRecent")}</p>
						) : (
							<div className="recent-cards">
								{recentFiltered.map((session) => <RecentSessionCard key={session.id} session={session} />)}
							</div>
						)}
					</section>
				)}
				{SECTION_ORDER.filter(({ state }) => stateFilter === "all" || state === stateFilter).map(({ state }) => (
					<BoardSection key={state} state={state} list={visibleByState.get(state) ?? []} />
				))}
				{filtersActive && total === 0 && recentFiltered.length === 0 && (
					<div className="empty">
						<h2>{t("board.noMatch")}</h2>
						<p>{t("board.noMatchHint")}</p>
					</div>
				)}
				{sessions.length === 0 && (
					<div className="empty">
						<EmptyBoardIllustration />
						<h2>{t("board.empty")}</h2>
						<p>{t("board.emptyHint")}</p>
					</div>
				)}
			</div>
			<aside className="board-rail">
				<UsageHeatmap />
				<DailyCostChart />
			</aside>
		</div>
	);
}

function matchesQuery(needle: string, fields: Array<string | undefined>): boolean {
	if (!needle) return true;
	return fields.some((field) => field?.toLowerCase().includes(needle));
}

interface FilteredBoard {
	visibleByState: Map<SessionState, BoardSession[]>;
	recentFiltered: RecentSessionDTO[];
	/** Sessions that will render as section cards under the current state filter. */
	total: number;
}

function applyFilters(
	sessions: BoardSession[],
	recent: RecentSessionDTO[] | null,
	needle: string,
	stateFilter: SessionState | "all",
): FilteredBoard {
	const visible = needle
		? sessions.filter((s) => matchesQuery(needle, [s.title, s.projectName, s.branch, s.modelId]))
		: sessions;
	const visibleByState = groupByState(visible);
	const recentFiltered = (recent ?? []).filter(
		(r) =>
			matchesQuery(needle, [r.title, r.projectName]) &&
			(stateFilter === "all" || r.state === stateFilter),
	);
	const total = stateFilter === "all" ? visible.length : (visibleByState.get(stateFilter)?.length ?? 0);
	return { visibleByState, recentFiltered, total };
}

function BoardToolbar({ query, onQuery, stateFilter, onStateFilter, chips }: {
	query: string;
	onQuery: (query: string) => void;
	stateFilter: SessionState | "all";
	onStateFilter: (filter: SessionState | "all") => void;
	chips: Array<{ value: SessionState | "all"; label: string; count: number }>;
}) {
	const { t } = useI18n();
	return (
		<div className="board-toolbar">
			<label className="board-search">
				<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
					<circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
					<line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
				</svg>
				<input
					value={query}
					onChange={(event) => onQuery(event.target.value)}
					placeholder={t("board.search")}
					aria-label={t("board.search")}
				/>
			</label>
			<div className="board-chips" role="group" aria-label={t("board.filterLabel")}>
				{chips.map((chip) => (
					<button
						key={chip.value}
						type="button"
						className={stateFilter === chip.value ? "on" : ""}
						onClick={() => onStateFilter(chip.value)}
					>
						{chip.label}
						<span className="chip-count">{chip.count}</span>
					</button>
				))}
			</div>
		</div>
	);
}

function BoardSection({ state, list }: { state: SessionState; list: BoardSession[] }) {
	const { t } = useI18n();
	if (state !== "waiting_approval" && list.length === 0) return null;
	return (
		<section className={`board-section section-${state}`}>
			<header>
				<h2>
					<StateIcon state={state} /> {t(`state.${state}` as MsgKey)}
				</h2>
				<span className="count">{list.length}</span>
				<span className="hint">{t(`board.hint.${state}` as MsgKey)}</span>
			</header>
			{list.length === 0 ? (
				<p className="muted">{t("board.nothing_waiting")}</p>
			) : (
				<div className="cards">
					{list.map((s) => (
						<SessionCard key={s.id} session={s} />
					))}
				</div>
			)}
		</section>
	);
}

function HeroTile({ label, value }: { label: string; value: string | number }) {
	return (
		<div className="hero-tile">
			<span className="hero-label">{label}</span>
			<strong>{value}</strong>
		</div>
	);
}

const CHART_DAYS = 14;
const HEATMAP_WEEKS = 20;

/** Pad the server series (only days with sessions) to a continuous UTC day range ending today. */
function fillDailySeries(rows: DailyStatDTO[], days: number): DailyStatDTO[] {
	const byDay = new Map(rows.map((r) => [r.day, r]));
	const series: DailyStatDTO[] = [];
	const today = new Date();
	for (let i = days - 1; i >= 0; i--) {
		const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
		const key = d.toISOString().slice(0, 10);
		series.push(byDay.get(key) ?? { day: key, sessionCount: 0, turnCount: 0, totalCostUsd: 0, totalTokens: 0 });
	}
	return series;
}

/** GitHub-style contribution grid over daily token usage; weeks are columns, Monday-first rows. */
function UsageHeatmap() {
	const { t } = useI18n();
	const { data } = useResource<DailyStatDTO[]>(`/api/stats/daily?days=${HEATMAP_WEEKS * 7}`);
	const [hover, setHover] = useState<{ stat: DailyStatDTO; x: number; y: number } | null>(null);
	const series = fillDailySeries(data ?? [], HEATMAP_WEEKS * 7);
	const total = series.reduce((n, d) => n + d.totalTokens, 0);
	const max = Math.max(...series.map((d) => d.totalTokens));
	// Monday-first rows: shift the grid start back to the Monday of week one.
	const first = new Date(`${series[0].day}T00:00:00Z`);
	const leadBlanks = (first.getUTCDay() + 6) % 7;
	const level = (tokens: number): number => {
		if (tokens <= 0 || max <= 0) return 0;
		const ratio = tokens / max;
		if (ratio < 0.25) return 1;
		if (ratio < 0.5) return 2;
		if (ratio < 0.75) return 3;
		return 4;
	};
	return (
		<section className="rail-card heatmap-card">
			<header>
				<h2>{t("heatmap.title")}</h2>
				<span className="chart-total">{fmtTokens(total)}</span>
			</header>
			<div className="heatmap" role="img" aria-label={t("heatmap.title")}>
				{Array.from({ length: leadBlanks }, (_, i) => (
					<span key={`blank-${i}`} className="hm-cell hm-blank" />
				))}
				{series.map((d) => (
					<span
						key={d.day}
						className={`hm-cell l${level(d.totalTokens)}`}
						onMouseEnter={(e) => {
							const r = e.currentTarget.getBoundingClientRect();
							setHover({ stat: d, x: r.left + r.width / 2, y: r.top });
						}}
						onMouseLeave={() => setHover(null)}
					/>
				))}
			</div>
			{hover && (
				<div className="hm-tip" style={{ left: hover.x, top: hover.y }}>
					<strong>{hover.stat.day}</strong>
					<span>
						{fmtTokens(hover.stat.totalTokens)} tokens · {fmtCost(hover.stat.totalCostUsd)}
					</span>
					<span>
						{t("history.sessions", { n: hover.stat.sessionCount })} · {t("board.turns", { n: hover.stat.turnCount })}
					</span>
				</div>
			)}
			<footer className="heatmap-legend">
				<span>{t("heatmap.less")}</span>
				{[0, 1, 2, 3, 4].map((l) => (
					<span key={l} className={`hm-cell l${l}`} />
				))}
				<span>{t("heatmap.more")}</span>
			</footer>
		</section>
	);
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(Math.round(n));
}

function DailyCostChart() {
	const { t } = useI18n();
	const { data } = useResource<DailyStatDTO[]>(`/api/stats/daily?days=${CHART_DAYS}`);
	const series = fillDailySeries(data ?? [], CHART_DAYS);
	const total = series.reduce((n, d) => n + d.totalCostUsd, 0);
	const max = Math.max(...series.map((d) => d.totalCostUsd));

	const W = 280;
	const H = 120;
	const padX = 10;
	const padTop = 16;
	const padBottom = 20;
	const innerW = W - padX * 2;
	const innerH = H - padTop - padBottom;
	const points = series.map((d, i) => {
		const x = padX + (i / (series.length - 1)) * innerW;
		const y = padTop + innerH - (max > 0 ? (d.totalCostUsd / max) * innerH : 0);
		return { ...d, x, y };
	});
	const line = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
	const area = `${padX},${padTop + innerH} ${line} ${padX + innerW},${padTop + innerH}`;
	const dayLabel = (iso: string) => iso.slice(5).replace("-", "/");

	return (
		<section className="rail-card chart-card">
			<header>
				<h2>{t("chart.title")}</h2>
				<span className="chart-total">{fmtCost(total)}</span>
			</header>
			<svg viewBox={`0 0 ${W} ${H}`} className="daily-chart" role="img" aria-label={t("chart.title")}>
				<defs>
					<linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
						<stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
					</linearGradient>
				</defs>
				{max > 0 ? (
					<>
						<polygon points={area} fill="url(#chart-fill)" />
						<polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
						{points.map((p) => (
							<circle key={p.day} cx={p.x} cy={p.y} r="2" fill="var(--accent)">
								<title>{`${p.day} · ${fmtCost(p.totalCostUsd)} · ${t("board.turns", { n: p.sessionCount })}`}</title>
							</circle>
						))}
						<text x={padX} y={10} className="chart-y-label">{fmtCost(max)}</text>
					</>
				) : (
					<text x={W / 2} y={H / 2} textAnchor="middle" className="chart-empty">
						{t("chart.empty")}
					</text>
				)}
				<text x={padX} y={H - 5} className="chart-x-label">{dayLabel(series[0].day)}</text>
				<text x={W - padX} y={H - 5} textAnchor="end" className="chart-x-label">
					{dayLabel(series[series.length - 1].day)}
				</text>
			</svg>
		</section>
	);
}

function RecentSessionCard({ session }: { session: RecentSessionDTO }) {
	const { t } = useI18n();
	return (
		<Link to={`/sessions/${session.id}`} className="recent-card">
			<span className={`recent-state state-${session.state}`}>{t(`state.${session.state}` as MsgKey)}</span>
			<strong>{session.title ?? t("board.untitled")}</strong>
			<span className="recent-project">{session.projectName}</span>
			<span className="recent-meta">{t("board.turns", { n: session.turnCount })} · {t("detail.active", { elapsed: fmtElapsed(session.lastActivityAt) })}</span>
		</Link>
	);
}

function SessionCard({ session: s }: { session: BoardSession }) {
	const { t } = useI18n();
	const todo = s.todo;
	const contextPct = s.contextWindow ? Math.min(100, Math.round((100 * (s.contextTokens ?? 0)) / s.contextWindow)) : undefined;
	return (
		<Link to={`/sessions/${s.id}`} className={`card state-${s.state}`}>
			<div className="card-head">
				<span className="project">{s.projectName}</span>
				{s.branch && <span className="branch">{s.branch}</span>}
				<span className={`state state-${s.state}`}>{t(`state.${s.state}` as MsgKey)}</span>
			</div>
			<div className="card-title">{s.title ?? t("board.untitled")}</div>
			{todo && (
				<div className="todo-progress">
					<div className="todo-bar">
						<div
							className="todo-fill"
							style={{ width: `${todo.total ? (100 * todo.done) / todo.total : 0}%` }}
						/>
					</div>
					<span className="todo-count">
						{todo.done}/{todo.total}
					</span>
					{todo.current && <span className="todo-current">→ {todo.current}</span>}
				</div>
			)}
			{s.lastMessage?.excerpt && (
				<div className="last-message">
					<span className="role-chip">{s.lastMessage.role}</span>
					<span className="excerpt">{s.lastMessage.excerpt.slice(0, 140)}</span>
				</div>
			)}
			<div className="card-meta">
				<span>{fmtElapsed(s.startedAt, s.lastActivityAt)}</span>
				<span>{t("board.turns", { n: s.turnCount })}</span>
				{s.modelId && <span className="mono">{s.modelId}</span>}
				<span>{fmtCost(s.totalCostUsd)}</span>
				{contextPct != null && (
					<span className="metric context-metric" title={t("board.contextHint", { used: fmtTokens(s.contextTokens ?? 0), total: fmtTokens(s.contextWindow ?? 0) })}>
						<span className="context-bar">
							<span className={`context-fill${contextPct >= 90 ? " hot" : ""}`} style={{ width: `${contextPct}%` }} />
						</span>
					</span>
				)}
				{s.pendingApprovals > 0 && (
					<span className="approval-badge">{t("board.pendingApproval", { n: s.pendingApprovals })}</span>
				)}
			</div>
		</Link>
	);
}
