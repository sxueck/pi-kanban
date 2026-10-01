import { useState } from "react";
import { Link } from "react-router-dom";
import type { ApprovalDTO } from "@pi-kanban/shared";
import { apiPost, fmtAgo, fmtTime, useResource } from "../api.js";
import { useI18n } from "../i18n.js";
import type { MsgKey } from "../i18n.js";
import { NoApprovalsIllustration } from "../components/illustrations.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/states.js";

export function Approvals() {
	const { t, locale } = useI18n();
	const [refreshKey, setRefreshKey] = useState(0);
	const { data, error, loading } = useResource<ApprovalDTO[]>("/api/approvals", refreshKey);

	async function decide(id: string, decision: "approved" | "denied") {
		try {
			await apiPost(`/api/approvals/${id}/decision`, { decision });
		} finally {
			setRefreshKey((k) => k + 1);
		}
	}

	if (error) return <ErrorState error={error} onRetry={() => setRefreshKey((k) => k + 1)} />;

	const rows = data ?? [];
	const pending = rows.filter((r) => r.status === "pending");
	const history = rows.filter((r) => r.status !== "pending");

	return (
		<div className="approvals">
			<header className="page-head">
				<div>
					<p className="page-eyebrow">{t("nav.approvals")}</p>
					<h1 className="page-title">{t("approvals.pending", { n: pending.length })}</h1>
					<p>{t("approvals.hint")}</p>
				</div>
			</header>
			<section aria-live="polite" aria-busy={loading}>
				{loading && !data ? (
					<SkeletonRows count={3} />
				) : pending.length === 0 ? (
					<EmptyState
						illustration={<NoApprovalsIllustration />}
						title={t("approvals.allClear")}
						hint={t("approvals.nothingWaiting")}
					/>
				) : (
					pending.map((a, i) => (
						<article key={a.id} className="approval pending" style={{ "--i": i } as React.CSSProperties}>
							<div className="approval-main">
								<div className="approval-head">
									<span className="policy">{a.policyLabel}</span>
									<span className="mono">{a.toolName}</span>
									<span className="hint" title={fmtTime(a.requestedAt)}>
										{fmtAgo(a.requestedAt, locale)}
									</span>
									{a.localPrompted && <span className="hint local">{t("approvals.localPrompt")}</span>}
								</div>
								<div className="approval-context">
									<span className="project">{a.projectName}</span>
									{a.sessionTitle ?? a.sessionId}
								</div>
								<details className="approval-input">
									<summary>{t("approvals.args")}</summary>
									<pre>{JSON.stringify(a.input, null, 2)}</pre>
								</details>
							</div>
							<div className="approval-actions">
								<button
									type="button"
									className="approve"
									aria-label={t("approvals.approveAria", { tool: a.toolName })}
									onClick={() => void decide(a.id, "approved")}
								>
									{t("approvals.approve")}
								</button>
								<button
									type="button"
									className="deny"
									aria-label={t("approvals.denyAria", { tool: a.toolName })}
									onClick={() => void decide(a.id, "denied")}
								>
									{t("approvals.deny")}
								</button>
							</div>
						</article>
					))
				)}
			</section>
			{history.length > 0 && (
				<section className="board-section">
					<header>
						<h2>{t("approvals.recent")}</h2>
						<span className="count">{history.length}</span>
					</header>
					<table className="table">
						<caption className="sr-only">{t("approvals.recent")}</caption>
						<thead>
							<tr>
								<th scope="col">{t("th.when")}</th>
								<th scope="col">{t("th.policy")}</th>
								<th scope="col">{t("th.tool")}</th>
								<th scope="col">{t("th.session")}</th>
								<th scope="col">{t("th.outcome")}</th>
								<th scope="col">{t("th.by")}</th>
							</tr>
						</thead>
						<tbody>
							{history.map((a) => (
								<tr key={a.id}>
									<td className="nowrap" title={a.decidedAt ? fmtTime(a.decidedAt) : undefined}>
										{a.decidedAt ? fmtAgo(a.decidedAt, locale) : "—"}
									</td>
									<td>{a.policyLabel}</td>
									<td className="mono">{a.toolName}</td>
									<td className="approval-row-session">
										<Link to={`/sessions/${a.sessionId}`}>{a.projectName}</Link>
									</td>
									<td className={`status-${a.status}`}>{t(`approvals.status.${a.status}` as MsgKey)}</td>
									<td>{a.decidedBy ?? (a.status === "local_resolved" ? t("approvals.localTui") : "—")}</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>
			)}
		</div>
	);
}
