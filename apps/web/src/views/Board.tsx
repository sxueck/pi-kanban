import { Link } from "react-router-dom";
import type { BoardSession, RecentSessionDTO, SessionState } from "@pi-kanban/shared";
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

export function Board() {
	const { t } = useI18n();
	const { data, error, loading } = useResource<BoardSession[]>("/api/board");
	const { data: recent, error: recentError } = useResource<RecentSessionDTO[]>("/api/sessions/recent");
	if (error || recentError) return <div className="error">{String(error ?? recentError)}</div>;
	if (loading && !data) return <div className="empty">loading…</div>;

	const sessions = data ?? [];
	const byState = new Map<SessionState, BoardSession[]>();
	for (const s of sessions) {
		const list = byState.get(s.state) ?? [];
		list.push(s);
		byState.set(s.state, list);
	}

	return (
		<div className="board">
			<section className="board-section recent-section">
				<header>
					<h2>{t("board.recent")}</h2>
				</header>
				{(recent?.length ?? 0) === 0 ? (
					<p className="muted">{t("board.noRecent")}</p>
				) : (
					<div className="recent-cards">
						{recent?.map((session) => <RecentSessionCard key={session.id} session={session} />)}
					</div>
				)}
			</section>
			{SECTION_ORDER.map(({ state }) => {
				const list = byState.get(state) ?? [];
				if (state !== "waiting_approval" && list.length === 0) return null;
				return (
					<section key={state} className={`board-section section-${state}`}>
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
			})}
			{sessions.length === 0 && (
				<div className="empty">
					<EmptyBoardIllustration />
					<h2>{t("board.empty")}</h2>
					<p>{t("board.emptyHint")}</p>
				</div>
			)}
		</div>
	);
}

function RecentSessionCard({ session }: { session: RecentSessionDTO }) {
	const { t } = useI18n();
	return (
		<Link to={`/sessions/${session.id}`} className="recent-card">
			<span className={`recent-state state-${session.state}`}>{t(`state.${session.state}` as MsgKey)}</span>
			<strong>{session.title ?? t("board.untitled")}</strong>
			<span className="recent-project">{session.projectName}</span>
			<span className="recent-meta">{t("board.turns", { n: session.turnCount })} · {fmtElapsed(session.lastActivityAt)}</span>
		</Link>
	);
}

function SessionCard({ session: s }: { session: BoardSession }) {
	const { t } = useI18n();
	const todo = s.todo;
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
				{s.pendingApprovals > 0 && (
					<span className="approval-badge">{t("board.pendingApproval", { n: s.pendingApprovals })}</span>
				)}
			</div>
		</Link>
	);
}
