import { useState } from "react";
import type { ApprovalDTO } from "@pi-kanban/shared";
import { apiPost, fmtTime, useResource } from "../api.js";
import { useI18n } from "../i18n.js";
import type { MsgKey } from "../i18n.js";
import { NoApprovalsIllustration } from "../components/illustrations.js";

export function Approvals() {
	const { t } = useI18n();
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
					<h2>{t("approvals.pending", { n: pending.length })}</h2>
				</header>
				{pending.length === 0 && (
					<div className="approvals-clear">
						<NoApprovalsIllustration />
						<div>
							<strong>{t("approvals.allClear")}</strong>
							<span>{t("approvals.nothingWaiting")}</span>
						</div>
					</div>
				)}
				{pending.map((a) => (
					<article key={a.id} className="approval pending">
						<div className="approval-main">
							<div className="approval-head">
								<span className="policy">{a.policyLabel}</span>
								<span className="mono">{a.toolName}</span>
								<span className="muted">{fmtTime(a.requestedAt)}</span>
							</div>
							<div className="approval-context">{a.projectName} · {a.sessionTitle ?? a.sessionId}</div>
							<details className="approval-input">
								<summary>查看调用参数</summary>
								<pre>{JSON.stringify(a.input, null, 2)}</pre>
							</details>
							{a.localPrompted && <span className="hint">{t("approvals.localPrompt")}</span>}
						</div>
						<div className="approval-actions">
							<button className="approve" onClick={() => void decide(a.id, "approved")}>{t("approvals.approve")}</button>
							<button className="deny" onClick={() => void decide(a.id, "denied")}>{t("approvals.deny")}</button>
						</div>
					</article>
				))}
			</section>
			<section>
				<header>
					<h2>{t("approvals.recent")}</h2>
				</header>
				<table className="table">
					<thead>
						<tr>
							<th>{t("th.when")}</th>
							<th>{t("th.policy")}</th>
							<th>{t("th.tool")}</th>
							<th>{t("th.outcome")}</th>
							<th>{t("th.by")}</th>
						</tr>
					</thead>
					<tbody>
						{history.map((a) => (
							<tr key={a.id}>
								<td>{a.decidedAt ? fmtTime(a.decidedAt) : "—"}</td>
								<td>{a.policyLabel}</td>
								<td className="mono">{a.toolName}</td>
								<td className={`status-${a.status}`}>{t(`approvals.status.${a.status}` as MsgKey)}</td>
								<td>{a.decidedBy ?? (a.status === "local_resolved" ? t("approvals.localTui") : "—")}</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>
		</div>
	);
}
