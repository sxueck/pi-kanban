import { Link } from "react-router-dom";
import type { BoardSession, SessionState } from "@pi-kanban/shared";
import { fmtCost, fmtElapsed, useResource } from "../api.js";

const SECTION_ORDER: Array<{ state: SessionState; title: string; hint: string }> = [
	{ state: "waiting_approval", title: "WAITING APPROVAL", hint: "blocked on your decision" },
	{ state: "running", title: "RUNNING", hint: "oldest first" },
	{ state: "idle", title: "IDLE", hint: "recently active first" },
	{ state: "offline", title: "OFFLINE", hint: "heartbeat stale" },
];

export function Board() {
	const { data, error, loading } = useResource<BoardSession[]>("/api/board");
	if (error) return <div className="error">{String(error)}</div>;
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
			{SECTION_ORDER.map(({ state, title, hint }) => {
				const list = byState.get(state) ?? [];
				if (state !== "waiting_approval" && list.length === 0) return null;
				return (
					<section key={state} className={`board-section section-${state}`}>
						<header>
							<h2>{title}</h2>
							<span className="count">{list.length}</span>
							<span className="hint">{hint}</span>
						</header>
						{list.length === 0 ? (
							<p className="muted">nothing waiting on you 🎉</p>
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
					<h2>No live pi sessions</h2>
					<p>Install the plugin on a machine running pi, then start a session.</p>
				</div>
			)}
		</div>
	);
}

function SessionCard({ session: s }: { session: BoardSession }) {
	const todo = s.todo;
	return (
		<Link to={`/sessions/${s.id}`} className={`card state-${s.state}`}>
			<div className="card-head">
				<span className="project">{s.projectName}</span>
				{s.branch && <span className="branch">{s.branch}</span>}
				<span className={`state state-${s.state}`}>{s.state.replace("_", " ")}</span>
			</div>
			<div className="card-title">{s.title ?? "(untitled session)"}</div>
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
				<span>{s.turnCount} turns</span>
				{s.modelId && <span className="mono">{s.modelId}</span>}
				<span>{fmtCost(s.totalCostUsd)}</span>
				{s.pendingApprovals > 0 && (
					<span className="approval-badge">{s.pendingApprovals} pending approval</span>
				)}
			</div>
		</Link>
	);
}
