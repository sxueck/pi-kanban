import { Link } from "react-router-dom";
import { useState } from "react";
import type { BoardSession, DailyStatDTO, LifetimeStatDTO, RecentSessionDTO, SessionState } from "@pi-kanban/shared";
import { fmtAgo, fmtCost, fmtElapsed, fmtTokens, useResource } from "../api.js";
import { useI18n } from "../i18n.js";
import type { MsgKey } from "../i18n.js";
import { StateIcon } from "../components/icons.js";
import { EmptyBoardIllustration } from "../components/illustrations.js";
import { EmptyState, ErrorState, Skeleton, SkeletonCards } from "../components/states.js";

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
	const [query, setQuery] = useState("");
	const [stateFilter, setStateFilter] = useState<SessionState | "all">("all");
	const [retry, setRetry] = useState(0);
	const { data, error, loading } = useResource<BoardSession[]>("/api/board", retry);
	const { data: recent, error: recentError } = useResource<RecentSessionDTO[]>("/api/sessions/recent", retry);
	const { data: lifetime, error: lifetimeError } = useResource<LifetimeStatDTO>("/api/stats/total", retry);
	const failed = error ?? recentError ?? lifetimeError;
	// A transient poll failure must not unmount a live board: keep the stale
	// data on screen and demote the error to a banner above it.
	if (failed && !data) return <ErrorState error={failed} onRetry={() => setRetry((n) => n + 1)} />;
	if (loading && !data) return <BoardSkeleton />;

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
				{failed && <ErrorState error={failed} onRetry={() => setRetry((n) => n + 1)} />}
				<section className="board-hero">
					<div className="hero-main">
						<span className="hero-label">{t("hero.label")}</span>
						<strong className="hero-value">
							{stats.running}
							{stats.running > 0 && <span className="hero-live" aria-hidden="true" />}
						</strong>
						{stats.waiting > 0 && (
							<Link className="hero-cta" to="/approvals">
								{t("hero.review", { n: stats.waiting })}
								<span className="arrow" aria-hidden="true">→</span>
							</Link>
						)}
					</div>
					<div className="hero-tiles">
						<HeroTile i={0} label={t("hero.pending")} value={stats.waiting} />
						<HeroTile i={1} label={t("hero.idle")} value={stats.idle} />
						<HeroTile i={2} label={t("hero.projects")} value={stats.projects} />
						<HeroTile i={3} label={t("hero.totalProjects")} value={lifetime != null ? lifetime.totalProjects : "…"} />
						<HeroTile i={4} label={t("hero.totalSessions")} value={lifetime != null ? lifetime.totalSessions : "…"} />
						<HeroTile i={5} label={t("hero.cost")} value={lifetime != null ? fmtCost(lifetime.totalCostUsd) : "…"} />
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
								{recentFiltered.map((session, i) => (
									<RecentSessionCard key={session.id} session={session} i={i} />
								))}
							</div>
						)}
					</section>
				)}
				{SECTION_ORDER.filter(({ state }) => stateFilter === "all" || state === stateFilter).map(({ state }) => (
					<BoardSection key={state} state={state} list={visibleByState.get(state) ?? []} />
				))}
				{filtersActive && total === 0 && recentFiltered.length === 0 && (
					<EmptyState title={t("board.noMatch")} hint={t("board.noMatchHint")} />
				)}
				{sessions.length === 0 && (
					<EmptyState
						illustration={<EmptyBoardIllustration />}
						title={t("board.empty")}
						hint={t("board.emptyHint")}
					/>
				)}
			</div>
			<aside className="board-rail">
				<UsageHeatmap />
				<DailyCostChart />
			</aside>
		</div>
	);
}

/** Mirrors the loaded board's box model so first paint never shifts the page. */
function BoardSkeleton() {
	return (
		<div className="board-layout">
			<div className="board-main">
				<Skeleton className="skeleton-hero" />
				<Skeleton style={{ height: 36, width: 320, borderRadius: 999 }} />
				<div className="board-section" style={{ marginTop: 28 }}>
					<SkeletonCards count={6} min={3} />
				</div>
			</div>
			<aside className="board-rail">
				<Skeleton style={{ height: 168, borderRadius: "var(--radius)" }} />
				<Skeleton style={{ height: 168, borderRadius: "var(--radius)" }} />
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
						aria-pressed={stateFilter === chip.value}
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
					{list.map((s, i) => (
						<SessionCard key={s.id} session={s} i={i} />
					))}
				</div>
			)}
		</section>
	);
}

function HeroTile({ label, value, i = 0 }: { label: string; value: string | number; i?: number }) {
	return (
		<div className="hero-tile" style={{ "--i": i } as React.CSSProperties}>
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
	const peak = series.reduce((best, d) => (d.totalTokens > best.totalTokens ? d : best), series[0]);
	const tip = (d: DailyStatDTO, el: HTMLElement) => {
		const r = el.getBoundingClientRect();
		// Clamp to the viewport so a cell at either rail edge never clips the card.
		setHover({ stat: d, x: Math.min(Math.max(r.left + r.width / 2, 92), innerWidth - 92), y: r.top });
	};
	return (
		<section className="rail-card heatmap-card">
			<header>
				<h2>{t("heatmap.title")}</h2>
				<span className="chart-total">{fmtTokens(total)}</span>
			</header>
			<div
				className="heatmap"
				role="img"
				aria-label={t("heatmap.summary", {
					days: HEATMAP_WEEKS * 7,
						total: fmtTokens(total),
						peak: peak.totalTokens > 0 ? `${peak.day} (${fmtTokens(peak.totalTokens)})` : t("chart.empty"),
				})}
			>
				{Array.from({ length: leadBlanks }, (_, i) => (
					<span key={`blank-${i}`} className="hm-cell hm-blank" aria-hidden="true" />
				))}
				{series.map((d, i) => (
					<span
						key={d.day}
						className={`hm-cell l${level(d.totalTokens)}`}
						aria-hidden="true"
						style={{ "--i": i } as React.CSSProperties}
						onMouseEnter={(e) => tip(d, e.currentTarget)}
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

function DailyCostChart() {
	const { t } = useI18n();
	const { data } = useResource<DailyStatDTO[]>(`/api/stats/daily?days=${CHART_DAYS}`);
	const series = fillDailySeries(data ?? [], CHART_DAYS);
	const total = series.reduce((n, d) => n + d.totalCostUsd, 0);
	const max = Math.max(...series.map((d) => d.totalCostUsd));

	const W = 280;
	const H = 132;
	const padX = 12;
	const padTop = 18;
	const padBottom = 22;
	const innerW = W - padX * 2;
	const innerH = H - padTop - padBottom;
	const [hover, setHover] = useState<number | null>(null);
	const points = series.map((d, i) => {
		const x = padX + (i / (series.length - 1)) * innerW;
		const y = padTop + innerH - (max > 0 ? (d.totalCostUsd / max) * innerH : 0);
		return { ...d, x, y };
	});
	const baseY = padTop + innerH;
	const line = smoothPath(points, baseY);
	const area = `${line} L ${points[points.length - 1].x.toFixed(1)},${baseY} L ${points[0].x.toFixed(1)},${baseY} Z`;
	const dayLabel = (iso: string) => iso.slice(5).replace("-", "/");
	const active = hover == null ? null : points[hover];

	return (
		<section className="rail-card chart-card">
			<header>
				<h2>{t("chart.title")}</h2>
				<span className="chart-total">{fmtCost(total)}</span>
			</header>
			<div
				className="chart-wrap"
				onMouseMove={(event) => {
					const box = event.currentTarget.getBoundingClientRect();
					const vx = ((event.clientX - box.left) / box.width) * W;
					const step = innerW / (series.length - 1);
					const idx = Math.round((vx - padX) / step);
					setHover(idx >= 0 && idx < points.length ? idx : null);
				}}
				onMouseLeave={() => setHover(null)}
			>
				<svg viewBox={`0 0 ${W} ${H}`} className="daily-chart" role="img" aria-label={t("chart.summary", { days: CHART_DAYS, total: fmtCost(total) })}>
					<defs>
						<linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stopColor="var(--accent)" stopOpacity="0.3" />
							<stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
						</linearGradient>
					</defs>
					{max > 0 ? (
						<>
							{[0.5, 1].map((f) => (
								<line key={f} x1={padX} x2={W - padX} y1={baseY - innerH * f} y2={baseY - innerH * f} className="chart-grid" />
							))}
							<path d={area} fill="url(#chart-fill)" className="chart-area" />
							<path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" className="chart-line" />
							{active && (
								<>
									<line x1={active.x} x2={active.x} y1={padTop - 6} y2={baseY} className="chart-cursor" />
									<circle cx={active.x} cy={active.y} r="4.5" className="chart-dot" />
								</>
							)}
							<circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r="3" fill="var(--accent)" />
							<text x={padX} y={11} className="chart-y-label">{fmtCost(max)}</text>
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
				{active && (
					<div className="chart-tip" style={{ left: `${Math.min(Math.max((active.x / W) * 100, 22), 78)}%` }}>
						<strong>{fmtCost(active.totalCostUsd)}</strong>
						<span>{active.day}</span>
						<span>{t("history.sessions", { n: active.sessionCount })} · {t("board.turns", { n: active.turnCount })}</span>
					</div>
				)}
			</div>
		</section>
	);
}

/** Catmull-Rom to cubic bezier, clamped to the plot box so the curve never dips under the axis. */
function smoothPath(points: Array<{ x: number; y: number }>, maxY: number): string {
	if (points.length < 2) return "";
	const clamp = (v: number) => Math.max(0, Math.min(maxY, v));
	const f = (v: number) => v.toFixed(1);
	let d = `M ${f(points[0].x)},${f(points[0].y)}`;
	for (let i = 0; i < points.length - 1; i++) {
		const p0 = points[i - 1] ?? points[i];
		const p1 = points[i];
		const p2 = points[i + 1];
		const p3 = points[i + 2] ?? p2;
		d += ` C ${f(p1.x + (p2.x - p0.x) / 6)},${f(clamp(p1.y + (p2.y - p0.y) / 6))}`;
		d += ` ${f(p2.x - (p3.x - p1.x) / 6)},${f(clamp(p2.y - (p3.y - p1.y) / 6))}`;
		d += ` ${f(p2.x)},${f(p2.y)}`;
	}
	return d;
}

function RecentSessionCard({ session, i = 0 }: { session: RecentSessionDTO; i?: number }) {
	const { t, locale } = useI18n();
	return (
		<Link
			to={`/sessions/${session.id}`}
			className="recent-card"
			style={{ "--i": i } as React.CSSProperties}
		>
			<span className={`recent-state state-${session.state}`}>{t(`state.${session.state}` as MsgKey)}</span>
			<strong>{session.title ?? t("board.untitled")}</strong>
			<span className="recent-project">{session.projectName}</span>
			<span className="recent-meta">
				{t("board.turns", { n: session.turnCount })} · {fmtAgo(session.lastActivityAt, locale)}
			</span>
		</Link>
	);
}

function SessionCard({ session: s, i = 0 }: { session: BoardSession; i?: number }) {
	const { t } = useI18n();
	const todo = s.todo;
	return (
		<Link to={`/sessions/${s.id}`} className={`card state-${s.state}`} style={{ "--i": i } as React.CSSProperties }>
			<div className="card-head">
				<span className="project">{s.projectName}</span>
				{s.branch && <span className="branch">{s.branch}</span>}
				<span className={`state state-${s.state}`}>{t(`state.${s.state}` as MsgKey)}</span>
			</div>
			<div className="card-title">{s.title ?? t("board.untitled")}</div>
			{todo && (
				<div className="todo-progress">
					<div className="todo-track">
						<div className="todo-bar">
							<div
								className="todo-fill"
								style={{ width: `${todo.total ? (100 * todo.done) / todo.total : 0}%` }}
							/>
						</div>
						<span className="todo-count">
							{todo.done}/{todo.total}
						</span>
					</div>
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
				{s.modelId && <span className="mono model">{s.modelId}</span>}
				<span className="cost">{fmtCost(s.totalCostUsd)}</span>
				{s.pendingApprovals > 0 && (
					<span className="approval-badge">{t("board.pendingApproval", { n: s.pendingApprovals })}</span>
				)}
			</div>
		</Link>
	);
}
