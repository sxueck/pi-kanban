import { useState } from "react";
import { Link } from "react-router-dom";
import type {
	ConsistencyDTO,
	FindingEvidence,
	GlobalFindingDTO,
	ProjectMemoryDTO,
	ProjectMemoryKind,
	ProjectMemoryStatus,
} from "@pi-kanban/shared";
import { apiErrorMessage, apiPost, fmtTime, useResource } from "../api.js";
import { useI18n } from "../i18n.js";
import { Skeleton } from "../components/skeleton.js";
import type { MsgKey } from "../i18n.js";

const MEMORY_KINDS: ProjectMemoryKind[] = ["decision", "preference", "fact", "pattern", "issue"];

/** Manage global decision principles and triage cross-project audit findings. */
export function Consistency() {
	const { t } = useI18n();
	const [refreshKey, setRefreshKey] = useState(0);
	const [actionError, setActionError] = useState<string | null>(null);
	const [actionNotice, setActionNotice] = useState<string | null>(null);
	const [running, setRunning] = useState(false);
	const { data, error, loading } = useResource<ConsistencyDTO>("/api/consistency", refreshKey);
	const global = data?.global;
	const refresh = () => setRefreshKey((key) => key + 1);

	async function runAudit() {
		setActionError(null);
		setActionNotice(null);
		setRunning(true);
		try {
			await apiPost("/api/consistency/inspect", {});
			setActionNotice(t("consistency.auditQueued"));
			refresh();
		} catch (err) {
			setActionError(apiErrorMessage(err));
		} finally {
			setRunning(false);
		}
	}

	return (
		<div className="consistency-view">
			<header className="consistency-header">
				<div>
					<h1 className="page-title">{t("consistency.title")}</h1>
					<p className="muted">{t("consistency.subtitle")}</p>
				</div>
			</header>
			{error && <div className="error" role="alert">{apiErrorMessage(error)}</div>}
			{loading && !data && <Skeleton className="consistency-skeleton" rows={3} labelKey="common.loading" />}
			{actionError && <div className="error consistency-feedback" role="alert">{actionError}</div>}
			{actionNotice && <div className="notice consistency-feedback" role="status">{actionNotice}</div>}
			{global && (
				<div className="consistency-main">
					<AuditCard state={global.state} runs={global.runs} busy={running} onRun={() => void runAudit()} />
					<GlobalMemoriesCard
						memories={global.memories}
						onError={setActionError}
						onNotice={setActionNotice}
						onChanged={refresh}
					/>
					<FindingsSection
						title={t("consistency.findings")}
						findings={global.findings.map((finding) => ({ finding, projectId: undefined, projectName: undefined }))}
						memories={global.memories}
						resolvable
						onError={setActionError}
						onNotice={setActionNotice}
						onChanged={refresh}
					/>
					<FindingsSection
						title={t("consistency.projectFindings")}
						findings={(data?.projectFindings ?? []).map((finding) => ({ finding: { ...finding }, projectId: finding.projectId, projectName: finding.projectName }))}
						memories={[]}
						onError={setActionError}
						onNotice={setActionNotice}
						onChanged={refresh}
					/>
				</div>
			)}
		</div>
	);
}

function AuditCard({ state, runs, busy, onRun }: {
	state: ConsistencyDTO["global"]["state"];
	runs: ConsistencyDTO["global"]["runs"];
	busy: boolean;
	onRun: () => void;
}) {
	const { t } = useI18n();
	const unavailable = state.eligibleProjects < 2;
	return (
		<section className="board-section consistency-audit-card">
			<header>
				<div>
					<h2>{t("consistency.runs")}</h2>
					<p className="muted">{t("consistency.corpusHint", { n: state.eligibleProjects })}</p>
				</div>
				<span className={`state ${state.running || busy ? "state-running" : "state-idle"}`}>
					{state.running || busy ? t("consistency.running") : t("consistency.never")}
				</span>
			</header>
			<div className="consistency-audit-body">
				<div>
					{!state.running && state.lastRunAt && <p className="memory-meta">{t("consistency.lastRun", { time: fmtTime(state.lastRunAt) })}</p>}
					{!state.running && state.lastError && <p className="error work-hint">{t("consistency.lastError")}: {state.lastError}</p>}
					{unavailable && <p className="muted work-hint">{t("consistency.needCorpus")}</p>}
				</div>
				<button type="button" disabled={busy || state.running || unavailable} onClick={onRun}>
					{state.running || busy ? t("consistency.running") : t("consistency.run")}
				</button>
			</div>
			{runs.length > 0 && (
				<ul className="audit-run-list" aria-label={t("consistency.runs")}>
					{runs.slice(0, 5).map((run) => (
						<li key={run.inspectionId}>
							<span className={`work-kind run-status-${run.status}`}>{run.status}</span>
							<span>{fmtTime(run.startedAt)}</span>
							<span className="muted">{run.trigger}</span>
							{run.error && <span className="run-error">{run.error}</span>}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function GlobalMemoriesCard({ memories, onError, onNotice, onChanged }: {
	memories: ProjectMemoryDTO[];
	onError: (message: string | null) => void;
	onNotice: (message: string | null) => void;
	onChanged: () => void;
}) {
	const { t } = useI18n();
	const [kind, setKind] = useState<ProjectMemoryKind>("decision");
	const [content, setContent] = useState("");
	const [creating, setCreating] = useState(false);
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [archiveTarget, setArchiveTarget] = useState<string | null>(null);
	const activeMemories = memories.filter((memory) => memory.status !== "archived");
	const archivedMemories = memories.filter((memory) => memory.status === "archived");

	async function create() {
		if (!content.trim() || creating) return;
		setCreating(true);
		onError(null);
		onNotice(null);
		try {
			await apiPost("/api/global/memories", { kind, content: content.trim() });
			setContent("");
			onNotice(t("consistency.created"));
			onChanged();
		} catch (err) {
			onError(apiErrorMessage(err));
		} finally {
			setCreating(false);
		}
	}

	async function setStatus(memoryId: string, status: ProjectMemoryStatus) {
		if (pendingId) return;
		setPendingId(memoryId);
		setArchiveTarget(null);
		onError(null);
		onNotice(null);
		try {
			await apiPost(`/api/global/memories/${memoryId}/status`, { status });
			onNotice(t("consistency.saved"));
			onChanged();
		} catch (err) {
			onError(apiErrorMessage(err));
		} finally {
			setPendingId(null);
		}
	}

	return (
		<section className="board-section global-memories-section">
			<header>
				<div>
					<h2>{t("consistency.globalMemories")}</h2>
					<p className="muted">{t("consistency.globalMemoriesHint")}</p>
				</div>
				<span className="count">{memories.length}</span>
			</header>
			<form className="global-memory-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
				<div className="global-memory-field global-memory-kind">
					<label htmlFor="global-memory-kind">{t("consistency.addKind")}</label>
					<select id="global-memory-kind" value={kind} onChange={(event) => setKind(event.target.value as ProjectMemoryKind)}>
						{MEMORY_KINDS.map((value) => (
							<option key={value} value={value}>{t(`memory.kind.${value}`)}</option>
						))}
					</select>
				</div>
				<div className="global-memory-field">
					<label htmlFor="global-memory-content">{t("consistency.addContentLabel")}</label>
					<input id="global-memory-content" value={content} placeholder={t("consistency.addContent")} onChange={(event) => setContent(event.target.value)} maxLength={600} />
				</div>
				<button type="submit" disabled={!content.trim() || creating}>{creating ? t("common.loading") : t("consistency.create")}</button>
			</form>
			{activeMemories.length === 0 ? (
				<p className="muted consistency-empty-copy">{t("consistency.memories.empty")}</p>
			) : (
				<MemoryList
					title={t("consistency.activeMemories")}
					memories={activeMemories}
					busyId={pendingId}
					archiveTarget={archiveTarget}
					onArchiveTarget={setArchiveTarget}
					onStatus={setStatus}
				/>
			)}
			{archivedMemories.length > 0 && (
				<details className="closed-findings archived-memories">
					<summary>{t("consistency.archivedMemories", { n: archivedMemories.length })}</summary>
					<MemoryList memories={archivedMemories} busyId={pendingId} archiveTarget={archiveTarget} onArchiveTarget={setArchiveTarget} onStatus={setStatus} />
				</details>
			)}
		</section>
	);
}

function MemoryList({ title, memories, busyId, archiveTarget, onArchiveTarget, onStatus }: {
	title?: string;
	memories: ProjectMemoryDTO[];
	busyId: string | null;
	archiveTarget: string | null;
	onArchiveTarget: (id: string | null) => void;
	onStatus: (memoryId: string, status: ProjectMemoryStatus) => void;
}) {
	return (
		<div className="consistency-memory-list">
			{title && <h3>{title}</h3>}
			<ul className="memory-list">
				{memories.map((memory) => (
					<GlobalMemoryItem
						key={memory.id}
						memory={memory}
						busy={busyId === memory.id}
						blocked={busyId !== null && busyId !== memory.id}
						archiveConfirming={archiveTarget === memory.id}
						onArchiveTarget={onArchiveTarget}
						onStatus={(status) => void onStatus(memory.id, status)}
					/>
				))}
			</ul>
		</div>
	);
}

const MEMORY_ACTIONS: Record<ProjectMemoryStatus, Array<{ status: ProjectMemoryStatus; key: MsgKey }>> = {
	candidate: [
		{ status: "confirmed", key: "memory.confirm" },
		{ status: "pinned", key: "memory.pin" },
		{ status: "archived", key: "memory.archive" },
	],
	confirmed: [
		{ status: "pinned", key: "memory.pin" },
		{ status: "archived", key: "memory.archive" },
	],
	pinned: [
		{ status: "confirmed", key: "memory.unpin" },
		{ status: "archived", key: "memory.archive" },
	],
	archived: [{ status: "candidate", key: "memory.restore" }],
};

function GlobalMemoryItem({ memory, busy, blocked, archiveConfirming, onArchiveTarget, onStatus }: {
	memory: ProjectMemoryDTO;
	busy: boolean;
	blocked: boolean;
	archiveConfirming: boolean;
	onArchiveTarget: (id: string | null) => void;
	onStatus: (status: ProjectMemoryStatus) => void;
}) {
	const { t } = useI18n();
	return (
		<li className="memory-item">
			<div className="memory-head">
				<span className={`memory-status memory-status-${memory.status}`}>{t(`memory.status.${memory.status}`)}</span>
				<span className="work-kind">{t(`memory.kind.${memory.kind}`)}</span>
			</div>
			<p className="memory-content">{memory.content}</p>
			<div className="memory-meta">
				{fmtTime(memory.createdAt)} · v{memory.version}
				{memory.occurrenceCount > 1 && <> · {t("work.memory.seen", { n: memory.occurrenceCount })}</>}
			</div>
			<div className="memory-actions">
				{MEMORY_ACTIONS[memory.status].map((action) => {
					if (action.status !== "archived") {
						return <button key={action.status} type="button" disabled={busy || blocked} onClick={() => onStatus(action.status)}>{busy ? t("common.loading") : t(action.key)}</button>;
					}
					if (archiveConfirming) {
						return (
							<>
								<button key="confirm-archive" className="danger" type="button" disabled={busy || blocked} onClick={() => onStatus("archived")}>{t("consistency.confirmArchive")}</button>
								<button key="cancel-archive" className="secondary" type="button" disabled={busy || blocked} onClick={() => onArchiveTarget(null)}>{t("consistency.cancel")}</button>
							</>
						);
					}
					return <button key={action.status} className="danger" type="button" disabled={busy || blocked} onClick={() => onArchiveTarget(memory.id)}>{t(action.key)}</button>;
				})}
			</div>
		</li>
	);
}

interface FindingLike {
	id: number;
	severity: string;
	summary: string;
	detail?: string;
	evidence: FindingEvidence[];
	occurrenceCount: number;
	resolution?: GlobalFindingDTO["resolution"];
	createdAt: number;
	lastSeenAt: number;
}

function FindingsSection({ title, findings, memories, resolvable, onError, onNotice, onChanged }: {
	title: string;
	findings: Array<{ finding: FindingLike; projectId?: number; projectName?: string }>;
	memories: ProjectMemoryDTO[];
	resolvable?: boolean;
	onError: (message: string | null) => void;
	onNotice: (message: string | null) => void;
	onChanged: () => void;
}) {
	const { t } = useI18n();
	const [pendingId, setPendingId] = useState<number | null>(null);
	const [dismissTarget, setDismissTarget] = useState<number | null>(null);
	const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
	const open = findings.filter(({ finding }) => finding.resolution === undefined || finding.resolution === "open");
	const closed = findings.filter(({ finding }) => finding.resolution === "resolved" || finding.resolution === "dismissed");

	async function setResolution(id: number, resolution: Exclude<GlobalFindingDTO["resolution"], undefined>) {
		if (pendingId !== null) return;
		setPendingId(id);
		setDismissTarget(null);
		onError(null);
		onNotice(null);
		try {
			await apiPost(`/api/global/findings/${id}/resolution`, { resolution });
			onNotice(t("consistency.saved"));
			onChanged();
		} catch (err) {
			onError(apiErrorMessage(err));
		} finally {
			setPendingId(null);
		}
	}

	return (
		<section className={`board-section findings-section${open.length === 0 ? " is-empty" : ""}`}>
			<header>
				<h2>{title}</h2>
				<span className="count">{open.length}</span>
			</header>
			{!resolvable && <p className="muted findings-read-only">{t("consistency.projectFindingsHint")}</p>}
			{open.length === 0 ? (
				<p className="muted">{t("consistency.findings.empty")}</p>
			) : (
				<ul className="memory-list">
					{open.map(({ finding, projectId, projectName }) => (
						<FindingRow key={`${projectId ?? "g"}-${finding.id}`} finding={finding} projectId={projectId} projectName={projectName} memoryById={memoryById} resolvable={resolvable} pending={pendingId === finding.id} blocked={pendingId !== null && pendingId !== finding.id} dismissConfirming={dismissTarget === finding.id} onDismissTarget={setDismissTarget} onResolve={setResolution} />
					))}
				</ul>
			)}
			{closed.length > 0 && (
				<details className="closed-findings">
					<summary>{t("consistency.resolved")}/{t("consistency.dismissed")} · {closed.length}</summary>
					<ul className="memory-list">
						{closed.map(({ finding, projectId, projectName }) => (
							<FindingRow key={`${projectId ?? "g"}-${finding.id}`} finding={finding} projectId={projectId} projectName={projectName} memoryById={memoryById} resolvable={resolvable} pending={pendingId === finding.id} blocked={pendingId !== null && pendingId !== finding.id} dismissConfirming={false} onDismissTarget={setDismissTarget} onResolve={setResolution} dimmed />
						))}
					</ul>
				</details>
			)}
		</section>
	);
}

function FindingRow({ finding, projectId, projectName, memoryById, resolvable, dimmed, pending, blocked, dismissConfirming, onDismissTarget, onResolve }: {
	finding: FindingLike;
	projectId?: number;
	projectName?: string;
	memoryById: Map<string, ProjectMemoryDTO>;
	resolvable?: boolean;
	dimmed?: boolean;
	pending: boolean;
	blocked: boolean;
	dismissConfirming: boolean;
	onDismissTarget: (id: number | null) => void;
	onResolve: (id: number, resolution: Exclude<GlobalFindingDTO["resolution"], undefined>) => void;
}) {
	const { t } = useI18n();
	return (
		<li className={`insight-item severity-${finding.severity}${dimmed ? " is-closed" : ""}`}>
			<div className="insight-head">
				<span className="work-kind">{t("finding.kind.direction_conflict")}</span>
				<span className="insight-label">{finding.summary}</span>
				{finding.resolution === "resolved" && <span className="work-kind">{t("consistency.resolved")}</span>}
				{finding.resolution === "dismissed" && <span className="work-kind">{t("consistency.dismissed")}</span>}
			</div>
			{finding.detail && <p className="work-detail">{finding.detail}</p>}
			{finding.evidence.length > 0 && (
				<div className="memory-evidence">
					{finding.evidence.map((entry, index) => {
						if (entry.memoryId) {
							const memory = memoryById.get(entry.memoryId);
							const label = memory ? `${t("finding.memoryRef")} ${memory.content.slice(0, 60)}${memory.content.length > 60 ? "…" : ""}` : `${t("finding.memoryRef")} #${entry.memoryId.slice(0, 8)}`;
							return projectId != null ? <Link key={index} className="mono" to={`/history/project/${projectId}`} title={entry.memoryId}>{label}</Link> : <span key={index} className="mono" title={entry.memoryId}>{label}</span>;
						}
						if (entry.sessionId) return <Link key={index} className="mono" to={`/sessions/${entry.sessionId}`} title={entry.sessionId}>#{entry.sessionId.slice(0, 8)}{entry.turnPosition != null ? ` @${entry.turnPosition}` : ""}</Link>;
						return null;
					})}
				</div>
			)}
			<div className="memory-meta">
				{projectName && projectId != null && <><Link to={`/history/project/${projectId}`}>{projectName}</Link> · </>}
				{fmtTime(finding.createdAt)}
				{finding.occurrenceCount > 1 && <> · {t("finding.seen", { n: finding.occurrenceCount })} · {t("finding.lastSeen", { time: fmtTime(finding.lastSeenAt) })}</>}
			</div>
			{resolvable && (
				<div className="memory-actions">
					{finding.resolution === undefined || finding.resolution === "open" ? (
						dismissConfirming ? (
							<>
								<button className="danger" type="button" disabled={pending || blocked} onClick={() => onResolve(finding.id, "dismissed")}>{t("consistency.confirmDismiss")}</button>
								<button className="secondary" type="button" disabled={pending || blocked} onClick={() => onDismissTarget(null)}>{t("consistency.cancel")}</button>
							</>
						) : (
							<>
								<button type="button" disabled={pending || blocked} onClick={() => onResolve(finding.id, "resolved")}>{pending ? t("common.loading") : t("consistency.resolve")}</button>
								<button className="danger" type="button" disabled={pending || blocked} onClick={() => onDismissTarget(finding.id)}>{t("consistency.dismiss")}</button>
							</>
						)
					) : (
						<button type="button" disabled={pending || blocked} onClick={() => onResolve(finding.id, "open")}>{t("consistency.reopen")}</button>
					)}
				</div>
			)}
		</li>
	);
}
