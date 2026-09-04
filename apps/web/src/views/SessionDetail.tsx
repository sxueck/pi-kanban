import { Link, useParams } from "react-router-dom";
import type { SessionDetailDTO } from "@pi-kanban/shared";
import { fmtCost, fmtElapsed, fmtTime, useResource } from "../api.js";

export function SessionDetail() {
	const { id } = useParams<{ id: string }>();
	const { data, error, loading } = useResource<SessionDetailDTO>(
		id ? `/api/sessions/${id}` : null,
	);
	if (error) return <div className="error">{String(error)}</div>;
	if (loading && !data) return <div className="empty">loading…</div>;
	if (!data) return null;
	const s = data;

	return (
		<div className="session-detail">
			<header className="detail-head">
				<Link to="/" className="back">
					← board
				</Link>
				<div>
					<div className="project">
						{s.projectName}
						{s.branch && <span className="branch">{s.branch}</span>}
						<span className={`state state-${s.state}`}>{s.state.replace("_", " ")}</span>
					</div>
					<h2>{s.title ?? s.id}</h2>
					<div className="card-meta">
						<span>started {fmtTime(s.startedAt)}</span>
						<span>active {fmtElapsed(s.startedAt, s.lastActivityAt)} ago</span>
						<span>{s.turnCount} turns</span>
						<span>{fmtCost(s.totalCostUsd)}</span>
						{s.modelId && <span className="mono">{s.modelId}</span>}
						<span className="mono muted">{s.cwd}</span>
					</div>
				</div>
			</header>

			{s.approvals.some((a) => a.status === "pending") && (
				<section className="approval-banner">
					<Link to="/approvals">
						{s.approvals.filter((a) => a.status === "pending").length} approval(s) waiting for
						your decision →
					</Link>
				</section>
			)}

			{s.todos.length > 0 && (
				<section>
					<h3>Todos</h3>
					<ul className="todos">
						{s.todos.map((t) => (
							<li key={t.position} className={`todo-${t.state}`}>
								<span className="todo-marker">[{marker(t.state)}]</span> {t.content}
							</li>
						))}
					</ul>
				</section>
			)}

			<section>
				<h3>Turns</h3>
				{s.turns.map((t) => (
					<div key={t.position} className={`turn ${t.state === "running" ? "turn-running" : ""}`}>
						<div className="turn-head">
							<span className="turn-pos">#{t.position}</span>
							<span className={`turn-state ${t.state}`}>{t.state}</span>
							<span className="muted">
								{fmtTime(t.startedAt)}
								{t.endedAt && ` · ${fmtElapsed(t.startedAt, t.endedAt)}`}
							</span>
						</div>
						<div className="turn-prompt">{t.prompt}</div>
					</div>
				))}
			</section>

			<section>
				<h3>Messages</h3>
				<div className="messages">
					{s.messages.map((m) => (
						<div key={m.position} className={`message message-${m.role}`}>
							<div className="message-head">
								<span className="role-chip">{m.customType ?? m.role}</span>
								{m.costUsd != null && <span>{fmtCost(m.costUsd)}</span>}
								<span className="muted">{fmtTime(m.timestamp)}</span>
							</div>
							{m.excerpt && <pre className="message-body">{m.excerpt}</pre>}
						</div>
					))}
				</div>
			</section>

			<section>
				<h3>Tool calls</h3>
				<table className="table">
					<thead>
						<tr>
							<th>Tool</th>
							<th>Input</th>
							<th>Result</th>
							<th>Duration</th>
						</tr>
					</thead>
					<tbody>
						{s.toolCalls.map((t) => (
							<tr key={t.toolCallId} className={t.isError ? "tool-error" : ""}>
								<td className="mono">{t.toolName}</td>
								<td>
									<details>
										<summary>{summarize(t.input)}</summary>
										<pre>{JSON.stringify(t.input, null, 2)}</pre>
									</details>
								</td>
								<td className="result-cell">
									{t.isError && <span className="error-flag">ERROR </span>}
									{t.resultExcerpt?.slice(0, 200)}
								</td>
								<td>{t.durationMs != null ? `${(t.durationMs / 1000).toFixed(1)}s` : "—"}</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>

			{s.approvals.length > 0 && (
				<section>
					<h3>Approvals</h3>
					<table className="table">
						<thead>
							<tr>
								<th>When</th>
								<th>Policy</th>
								<th>Tool</th>
								<th>Status</th>
								<th>By</th>
							</tr>
						</thead>
						<tbody>
							{s.approvals.map((a) => (
								<tr key={a.id}>
									<td>{fmtTime(a.requestedAt)}</td>
									<td>{a.policyLabel}</td>
									<td className="mono">{a.toolName}</td>
									<td className={`status-${a.status}`}>{a.status}</td>
									<td>{a.decidedBy ?? (a.status === "local_resolved" ? "local TUI" : "—")}</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>
			)}
		</div>
	);
}

function marker(state: string): string {
	if (["done", "completed"].includes(state)) return "x";
	if (["current", "in_progress"].includes(state)) return "~";
	return " ";
}

function summarize(input: unknown): string {
	try {
		const raw = JSON.stringify(input) ?? "";
		return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
	} catch {
		return String(input);
	}
}
