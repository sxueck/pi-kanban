import { useState } from "react";
import type { ApprovalDTO } from "@pi-kanban/shared";
import { apiErrorMessage, apiPost, fmtTime, useResource } from "../api.js";
import { useI18n } from "../i18n.js";
import type { MsgKey, Translator } from "../i18n.js";
import { NoApprovalsIllustration } from "../components/illustrations.js";
import { Skeleton } from "../components/skeleton.js";

type Decision = "approved" | "denied";
type DecisionTarget = { id: string; decision: Decision } | null;

export function Approvals() {
	const { t } = useI18n();
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

	if (error) return <div className="error" role="alert">{apiErrorMessage(error)}</div>;
	if (loading && !data) return <Skeleton className="approvals-skeleton" rows={2} labelKey="common.loading" />;
	const rows = data ?? [];
	const pending = rows.filter((row) => row.status === "pending");
	const history = rows.filter((row) => row.status !== "pending");

	return (
		<div className="approvals">
			<header className="approvals-header">
				<h1 className="page-title">{t("approvals.title")}</h1>
				<p className="muted">{t("approvals.subtitle")}</p>
			</header>
			{actionError && <div className="error approvals-feedback" role="alert">{actionError}</div>}
			{actionNotice && <div className="notice approvals-feedback" role="status">{actionNotice}</div>}
			<PendingApprovals rows={pending} pendingId={pendingId} target={decisionTarget} onTarget={setDecisionTarget} onDecide={decide} />
			<ApprovalHistory rows={history} />
		</div>
	);
}

function PendingApprovals({ rows, pendingId, target, onTarget, onDecide }: {
	rows: ApprovalDTO[];
	pendingId: string | null;
	target: DecisionTarget;
	onTarget: (target: DecisionTarget) => void;
	onDecide: (id: string, decision: Decision) => void;
}) {
	const { t } = useI18n();
	return (
		<section className="approvals-section">
			<header>
				<h2>{t("approvals.pending", { n: rows.length })}</h2>
			</header>
			{rows.length === 0 && <ApprovalsClear />}
			{rows.map((approval) => (
				<ApprovalRow
					key={approval.id}
					approval={approval}
					busy={pendingId === approval.id}
					blocked={pendingId !== null && pendingId !== approval.id}
					target={target?.id === approval.id ? target.decision : null}
					onTarget={onTarget}
					onDecide={onDecide}
				/>
			))}
		</section>
	);
}

function ApprovalsClear() {
	const { t } = useI18n();
	return (
		<div className="approvals-clear">
			<NoApprovalsIllustration />
			<div>
				<strong>{t("approvals.allClear")}</strong>
				<span>{t("approvals.nothingWaiting")}</span>
			</div>
		</div>
	);
}

function ApprovalRow({ approval, busy, blocked, target, onTarget, onDecide }: {
	approval: ApprovalDTO;
	busy: boolean;
	blocked: boolean;
	target: Decision | null;
	onTarget: (target: DecisionTarget) => void;
	onDecide: (id: string, decision: Decision) => void;
}) {
	const { t } = useI18n();
	return (
		<article className="approval pending">
			<div className="approval-main">
				<div className="approval-head">
					<span className="policy">{approval.policyLabel}</span>
					<span className="mono">{approval.toolName}</span>
					<span className="muted">{fmtTime(approval.requestedAt)}</span>
				</div>
				<div className="approval-context">{approval.projectName} · {approval.sessionTitle ?? approval.sessionId}</div>
				<details className="approval-input">
					<summary>{t("approvals.inputSummary")}</summary>
					<pre>{JSON.stringify(approval.input, null, 2)}</pre>
				</details>
				{approval.localPrompted && <span className="hint">{t("approvals.localPrompt")}</span>}
			</div>
			<ApprovalActions approvalId={approval.id} busy={busy} blocked={blocked} target={target} onTarget={onTarget} onDecide={onDecide} />
		</article>
	);
}

function ApprovalActions({ approvalId, busy, blocked, target, onTarget, onDecide }: {
	approvalId: string;
	busy: boolean;
	blocked: boolean;
	target: Decision | null;
	onTarget: (target: DecisionTarget) => void;
	onDecide: (id: string, decision: Decision) => void;
}) {
	const { t } = useI18n();
	const disabled = busy || blocked;
	if (target !== null) {
		const confirmKey = target === "approved" ? "approvals.confirmApprove" : "approvals.confirmDeny";
		const buttonClass = target === "approved" ? "approve" : "deny";
		return (
			<div className="approval-actions">
				<button className={buttonClass} type="button" disabled={disabled} onClick={() => onDecide(approvalId, target)}>{busy ? t("common.loading") : t(confirmKey)}</button>
				<button className="secondary" type="button" disabled={disabled} onClick={() => onTarget(null)}>{t("approvals.cancel")}</button>
			</div>
		);
	}
	return (
		<div className="approval-actions">
			<button className="approve" type="button" disabled={disabled} onClick={() => onTarget({ id: approvalId, decision: "approved" })}>{t("approvals.approve")}</button>
			<button className="deny" type="button" disabled={disabled} onClick={() => onTarget({ id: approvalId, decision: "denied" })}>{t("approvals.deny")}</button>
		</div>
	);
}

function ApprovalHistory({ rows }: { rows: ApprovalDTO[] }) {
	const { t } = useI18n();
	return (
		<section className="approvals-section">
			<header>
				<h2>{t("approvals.recent")}</h2>
			</header>
			{rows.length === 0 ? <p className="muted">{t("approvals.historyEmpty")}</p> : (
				<div className="table-wrap">
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
							{rows.map((approval) => <ApprovalHistoryRow key={approval.id} approval={approval} t={t} />)}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}

function ApprovalHistoryRow({ approval, t }: { approval: ApprovalDTO; t: Translator }) {
	return (
		<tr>
			<td>{approval.decidedAt ? fmtTime(approval.decidedAt) : t("common.none")}</td>
			<td>{approval.policyLabel}</td>
			<td className="mono">{approval.toolName}</td>
			<td className={`status-${approval.status}`}>{t(`approvals.status.${approval.status}` as MsgKey)}</td>
			<td>{approvalDecider(approval, t)}</td>
		</tr>
	);
}

function approvalDecider(approval: ApprovalDTO, t: Translator): string {
	if (approval.decidedBy) return approval.decidedBy;
	if (approval.status === "local_resolved") return t("approvals.localTui");
	return t("common.none");
}
