import { Link, useParams } from "react-router-dom";
import type { HistorySessionDTO, ProjectHistoryDTO } from "@pi-kanban/shared";
import { fmtCost, fmtTime, useResource } from "../api.js";

export function History() {
	const { data, error } = useResource<ProjectHistoryDTO[]>("/api/history");
	if (error) return <div className="error">{String(error)}</div>;
	const projects = data ?? [];
	return (
		<div className="history">
			<header>
				<h2>Projects</h2>
			</header>
			{projects.length === 0 && <p className="muted">no projects observed yet</p>}
			<div className="cards">
				{projects.map((p) => (
					<Link key={p.id} to={`/history/project/${p.id}`} className="card project-card">
						<div className="card-title">{p.name}</div>
						{p.gitRemote && <div className="mono muted">{p.gitRemote}</div>}
						<div className="card-meta">
							<span>{p.sessionCount} sessions</span>
							<span>{fmtCost(p.totalCostUsd)}</span>
							{p.lastActivityAt && <span>last {fmtTime(p.lastActivityAt)}</span>}
						</div>
					</Link>
				))}
			</div>
		</div>
	);
}

export function ProjectSessions() {
	const { id } = useParams<{ id: string }>();
	const { data, error } = useResource<HistorySessionDTO[]>(
		id ? `/api/projects/${id}/sessions` : null,
	);
	if (error) return <div className="error">{String(error)}</div>;
	const sessions = data ?? [];
	return (
		<div className="history">
			<header>
				<h2>Sessions</h2>
			</header>
			<table className="table">
				<thead>
					<tr>
						<th>Title</th>
						<th>State</th>
						<th>Turns</th>
						<th>Cost</th>
						<th>Started</th>
					</tr>
				</thead>
				<tbody>
					{sessions.map((s) => (
						<tr key={s.id}>
							<td>
								<Link to={`/sessions/${s.id}`}>{s.title ?? s.id}</Link>
							</td>
							<td className={`status-${s.state}`}>{s.state}</td>
							<td>{s.turnCount}</td>
							<td>{fmtCost(s.totalCostUsd)}</td>
							<td>{fmtTime(s.startedAt)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
