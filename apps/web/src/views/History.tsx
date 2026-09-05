import { Link, useParams } from "react-router-dom";
import type { HistorySessionDTO, ProjectHistoryDTO } from "@pi-kanban/shared";
import { fmtCost, fmtTime, useResource } from "../api.js";
import { useI18n } from "../i18n.js";
import { EmptyHistoryIllustration } from "../components/illustrations.js";

export function History() {
	const { t } = useI18n();
	const { data, error } = useResource<ProjectHistoryDTO[]>("/api/history");
	if (error) return <div className="error">{String(error)}</div>;
	const projects = data ?? [];
	return (
		<div className="history">
			<header>
				<h1 className="page-title">{t("history.title")}</h1>
			</header>
			{projects.length === 0 && (
				<div className="empty">
					<EmptyHistoryIllustration />
					<h2>{t("history.empty")}</h2>
					<p>{t("history.emptyHint")}</p>
				</div>
			)}
			<div className="cards">
				{projects.map((p) => (
					<Link key={p.id} to={`/history/project/${p.id}`} className="card project-card">
						<div className="card-title">{p.name}</div>
						{p.gitRemote && <div className="mono muted">{p.gitRemote}</div>}
						<div className="card-meta">
							<span>{t("history.sessions", { n: p.sessionCount })}</span>
							<span>{fmtCost(p.totalCostUsd)}</span>
							{p.lastActivityAt && <span>{t("history.last", { time: fmtTime(p.lastActivityAt) })}</span>}
						</div>
					</Link>
				))}
			</div>
		</div>
	);
}

export function ProjectSessions() {
	const { t } = useI18n();
	const { id } = useParams<{ id: string }>();
	const { data, error } = useResource<HistorySessionDTO[]>(
		id ? `/api/projects/${id}/sessions` : null,
	);
	if (error) return <div className="error">{String(error)}</div>;
	const sessions = data ?? [];
	return (
		<div className="history">
			<header>
				<h1 className="page-title">{t("sessions.title")}</h1>
			</header>
			<table className="table">
				<thead>
					<tr>
						<th>{t("th.title")}</th>
						<th>{t("th.state")}</th>
						<th>{t("th.turns")}</th>
						<th>{t("th.cost")}</th>
						<th>{t("th.started")}</th>
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
