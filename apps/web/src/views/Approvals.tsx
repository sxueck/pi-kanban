import { useState } from "react";
import type { ApprovalDTO } from "@pi-kanban/shared";
import { apiPost, fmtTime, useResource } from "../api.js";

export function Approvals() {
	const [refreshKey, setRefreshKey] = useState(0);
	const { data, error } = useResource<ApprovalDTO[]>("/api/approvals", refreshKey);

	async function decide(id: string, decision: "approved" | "denied") {
		try {
			await apiPost(`/api/approvals/${id}/decision`, { decision });
		} finally {
			setRefreshKey((k) => k + 1);
		}
	}

	if (error) return <div className="error">{String(error)}</div>;
	const rows = data ?? [];
	const pending = rows.filter((r) => r.status === "pending");
	const history = rows.filter((r) => r.status !== "pending");

	return (
		<div className="approvals">
			<section>
				<header>
					<h2>Pending ({pending.length})</h2>
				</header>
				{pending.length === 0 && <p className="muted">nothing waiting on you 🎉</p>}
				{pending.map((a) => (
					<article key={a.id} className="approval pending">
						<div className="approval-head">
							<span className="policy">{a.policyLabel}</span>
							<span className="mono">{a.toolName}</span>
							{a.localPrompted && <span className="hint">local prompt also open</span>}
							<span className="muted">{fmtTime(a.requestedAt)}</span>
						</div>
						<div className="approval-context">
							{a.projectName} · {a.sessionTitle ?? a.sessionId}
						</div>
						<pre>{JSON.stringify(a.input, null, 2)}</pre>
						<div className="approval-actions">
							<button className="approve" onClick={() => void decide(a.id, "approved")}>
								Approve
							</button>
							<button className="deny" onClick={() => void decide(a.id, "denied")}>
								Deny
							</button>
						</div>
					</article>
				))}
			</section>
			<section>
				<header>
					<h2>Recent decisions</h2>
				</header>
				<table className="table">
					<thead>
						<tr>
							<th>When</th>
							<th>Policy</th>
							<th>Tool</th>
							<th>Outcome</th>
							<th>By</th>
						</tr>
					</thead>
					<tbody>
						{history.map((a) => (
							<tr key={a.id}>
								<td>{a.decidedAt ? fmtTime(a.decidedAt) : "—"}</td>
								<td>{a.policyLabel}</td>
								<td className="mono">{a.toolName}</td>
								<td className={`status-${a.status}`}>{a.status}</td>
								<td>{a.decidedBy ?? (a.status === "local_resolved" ? "local TUI" : "—")}</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>
		</div>
	);
}
