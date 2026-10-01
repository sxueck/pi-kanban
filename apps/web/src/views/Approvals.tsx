import { useState } from "react";
import { Link } from "react-router-dom";
import type { ApprovalDTO } from "@pi-kanban/shared";
import { apiErrorMessage, apiPost, fmtAgo, fmtTime, useResource } from "../api.js";
import { useI18n } from "../i18n.js";
import type { MsgKey, Translator } from "../i18n.js";
import { NoApprovalsIllustration } from "../components/illustrations.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/states.js";

type Decision = "approved" | "denied";
type DecisionTarget = { id: string; decision: Decision } | null;

export function Approvals() {
	const { t, locale } = useI18n();
	const [refreshKey, setRefreshKey] = useState(0);
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [decisionTarget, setDecisionTarget] = useState<DecisionTarget>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [actionNotice, setActionNotice] = useState<string | null>(null);
	const { data, error, loading } = useResource<ApprovalDTO[]>("/api/approvals", refreshKey);

	async function decide(id: string, decision: Decision) {
		if (pendingId !== null) return;
		setPendingId(id);
		setDecisionTarget(null);
		setActionError(null);
		setActionNotice(null);
		try {
			await apiPost(`/api/approvals/${id}/decision`, { decision });
			setActionNotice(t("approvals.saved"));
			setRefreshKey((key) => key + 1);
		} catch (err) {
			setActionError(apiErrorMessage(err));
		} finally {
			setPendingId(null);
		}
	}

	if (error) return <ErrorState error={error} onRetry={() => setRefreshKey((k) => k + 1)} />;

	const rows = data ?? [];
	const pending = rows.filter((row) => row.status === "pending");
	const history = rows.filter((row) => row.status !== "pending");

	return (
		<div className="approvals">
			<header className="page-head">
				<div>
					<p className="page-eyebrow">{t("nav.approvals")}</p>
					<h1 className="page-title">{t("approvals.pending", { n: pending.length })}</h1>
					<p>{t("approvals.hint")}</p>
				</div>
			</header>
			{actionError && <div className="error approvals-feedback" role="alert">{actionError}</div>}
			{actionNotice && <div className="notice approvals-feedback" role="status">{actionNotice}</div>}
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
						<ApprovalRow
							key={a.id}
							approval={a}
							index={i}
							busy={pendingId === a.id}
							blocked={pendingId !== null && pendingId !== a.id}
							target={decisionTarget?.id === a.id ? decisionTarget.decision : null}
							onTarget={setDecisionTarget}
							onDecide={decide}
						/>
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
										{a.decidedAt ? fmtAgo(a.decidedAt, locale) : t("common.none")}
									</td>
									<td>{a.policyLabel}</td>
									<td className="mono">{a.toolName}</td>
									<td className="approval-row-session">
										<Link to={`/sessions/${a.sessionId}`}>{a.projectName}</Link>
									</td>
									<td className={`status-${a.status}`}>{t(`approvals.status.${a.status}` as MsgKey)}</td>
									<td>{approvalDecider(a, t)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>
			)}
		</div>
	);
}

function ApprovalRow({ approval, index, busy, blocked, target, onTarget, onDecide }: {
	approval: ApprovalDTO;
	index: number;
	busy: boolean;
	blocked: boolean;
	target: Decision | null;
	onTarget: (target: DecisionTarget) => void;
	onDecide: (id: string, decision: Decision) => void;
}) {
	const { t, locale } = useI18n();
	return (
		<article className="approval pending" style={{ "--i": index } as React.CSSProperties}>
			<div className="approval-main">
				<div className="approval-head">
					<span className="policy">{approval.policyLabel}</span>
					<span className="mono">{approval.toolName}</span>
					<span className="hint" title={fmtTime(approval.requestedAt)}>
						{fmtAgo(approval.requestedAt, locale)}
					</span>
					{approval.localPrompted && <span className="hint local">{t("approvals.localPrompt")}</span>}
				</div>
				<div className="approval-context">
					<span className="project">{approval.projectName}</span>
					{approval.sessionTitle ?? approval.sessionId}
				</div>
				<details className="approval-input">
					<summary>{t("approvals.args")}</summary>
					<pre>{JSON.stringify(approval.input, null, 2)}</pre>
				</details>
			</div>
			<div className="approval-actions">
				{target !== null ? (
					<>
						<button
							type="button"
							className={target === "approved" ? "approve" : "deny"}
							disabled={busy || blocked}
							onClick={() => onDecide(approval.id, target)}
						>
							{busy ? t("common.loading") : t(target === "approved" ? "approvals.confirmApprove" : "approvals.confirmDeny")}
						</button>
						<button type="button" className="secondary" disabled={busy || blocked} onClick={() => onTarget(null)}>
							{t("approvals.cancel")}
						</button>
					</>
				) : (
					<>
						<button
							type="button"
							className="approve"
							aria-label={t("approvals.approveAria", { tool: approval.toolName })}
							disabled={busy || blocked}
							onClick={() => onTarget({ id: approval.id, decision: "approved" })}
						>
							{t("approvals.approve")}
						</button>
						<button
							type="button"
							className="deny"
							aria-label={t("approvals.denyAria", { tool: approval.toolName })}
							disabled={busy || blocked}
							onClick={() => onTarget({ id: approval.id, decision: "denied" })}
						>
							{t("approvals.deny")}
						</button>
					</>
				)}
			</div>
		</article>
	);
}

function approvalDecider(approval: ApprovalDTO, t: Translator): string {
	if (approval.decidedBy) return approval.decidedBy;
	if (approval.status === "local_resolved") return t("approvals.localTui");
	return t("common.none");
}
