import { useRef, useState } from "react";
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
import type { MsgKey } from "../i18n.js";

const MEMORY_KINDS: ProjectMemoryKind[] = ["decision", "preference", "fact", "pattern", "issue"];

/**
 * Consistency workspace: manage product-wide decision principles, run the
 * global (cross-project) audit, and triage direction-conflict findings from
 * both global and per-project inspections.
 */
export function Consistency() {
	const { t } = useI18n();
	const [refreshKey, setRefreshKey] = useState(0);
	const [actionError, setActionError] = useState<string | null>(null);
	const [running, setRunning] = useState(false);
	const { data, error, loading } = useResource<ConsistencyDTO>("/api/consistency", refreshKey);
	const global = data?.global;

	async function runAudit() {
		setActionError(null);
		setRunning(true);
		try {
			await apiPost("/api/consistency/inspect", {});
			setRefreshKey((key) => key + 1);
		} catch (err) {
			setActionError(apiErrorMessage(err));
		} finally {
			setRunning(false);
		}
	}

	return (
		<div className="board-layout consistency-view">
			<div className="board-main">
				<header>
					<div>
						<h1 className="page-title">{t("consistency.title")}</h1>
						<p className="muted">{t("consistency.subtitle")}</p>
					</div>
				</header>
				{error && <div className="error">{apiErrorMessage(error)}</div>}
				{loading && !data && <div className="empty">{t("common.loading")}</div>}
				{actionError && <div className="error">{actionError}</div>}
				{global && (
					<div className="project-work-main">
						<div className="project-sessions consistency-main">
							<FindingsSection
								title={t("consistency.findings")}
								findings={global.findings.map((finding) => ({ finding, projectId: undefined, projectName: undefined }))}
								memories={global.memories}
								resolvable
								onError={setActionError}
								onChanged={() => setRefreshKey((key) => key + 1)}
							/>
							<FindingsSection
								title={t("consistency.projectFindings")}
								findings={(data?.projectFindings ?? []).map((finding) => ({ finding: { ...finding }, projectId: finding.projectId, projectName: finding.projectName }))}
								memories={[]}
								onError={setActionError}
								onChanged={() => setRefreshKey((key) => key + 1)}
							/>
						</div>
					</div>
				)}
			</div>
			<aside className="board-rail">
				{global && (
					<div className="rail-group">
						<AuditCard
							state={global.state}
							runs={global.runs}
							busy={running}
							onRun={() => void runAudit()}
						/>
						<GlobalMemoriesCard
							memories={global.memories}
							onError={setActionError}
							onChanged={() => setRefreshKey((key) => key + 1)}
						/>
					</div>
				)}
			</aside>
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
	return (
		<section className="rail-card rail-group-item inspection-card">
			<header>
				<h2>{t("consistency.runs")}</h2>
			</header>
			<span className={`state ${state.running ? "state-running" : "state-idle"}`}>
				{state.running ? t("consistency.running") : t("consistency.never")}
			</span>
			<div className="card-meta">
				<span>{t("consistency.corpusHint", { n: state.eligibleProjects })}</span>
				{!state.running && state.lastRunAt && <span>{t("consistency.lastRun", { time: fmtTime(state.lastRunAt) })}</span>}
			</div>
			{!state.running && state.lastError && <p className="error work-hint">{t("consistency.lastError")}: {state.lastError}</p>}
			<div className="inspection-actions">
				<button type="button" disabled={busy || state.running} onClick={onRun}>
					{state.running || busy ? t("consistency.running") : t("consistency.run")}
				</button>
			</div>
			{state.eligibleProjects < 2 && <p className="muted work-hint">{t("consistency.needCorpus")}</p>}
			{runs.length > 0 && (
				<ul className="memory-list audit-run-list">
					{runs.slice(0, 5).map((run) => (
						<li key={run.inspectionId} className="insight-item">
							<div className="insight-head">
								<span className={`work-kind run-status-${run.status}`}>{run.status}</span>
								<span className="insight-label">{fmtTime(run.startedAt)} · {run.trigger}</span>
							</div>
							{run.error && <p className="work-detail">{run.error}</p>}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function GlobalMemoriesCard({ memories, onError, onChanged }: {
	memories: ProjectMemoryDTO[];
	onError: (message: string | null) => void;
	onChanged: () => void;
}) {
	const { t } = useI18n();
	const [kind, setKind] = useState<ProjectMemoryKind>("decision");
	const [content, setContent] = useState("");
	const [creating, setCreating] = useState(false);
	const pending = useRef(new Set<string>());

	async function create() {
		if (!content.trim() || creating) return;
		setCreating(true);
		onError(null);
		try {
			await apiPost("/api/global/memories", { kind, content: content.trim() });
			setContent("");
			onChanged();
		} catch (err) {
			onError(apiErrorMessage(err));
		} finally {
			setCreating(false);
		}
	}

	async function setStatus(memoryId: string, status: ProjectMemoryStatus) {
		if (pending.current.has(memoryId)) return;
		pending.current.add(memoryId);
		onError(null);
		try {
			await apiPost(`/api/global/memories/${memoryId}/status`, { status });
			onChanged();
		} catch (err) {
			onError(apiErrorMessage(err));
		} finally {
			pending.current.delete(memoryId);
		}
	}

	return (
		<section className={`board-section rail-group-item memories-section${memories.length === 0 ? " is-empty" : ""}`}>
			<header>
				<h2>{t("consistency.globalMemories")}</h2>
				<span className="count">{memories.length}</span>
			</header>
			<p className="muted work-hint">{t("consistency.globalMemoriesHint")}</p>
			<div className="global-memory-form">
				<select value={kind} onChange={(event) => setKind(event.target.value as ProjectMemoryKind)} aria-label={t("consistency.addKind")}>
					{MEMORY_KINDS.map((value) => (
						<option key={value} value={value}>{t(`memory.kind.${value}`)}</option>
					))}
				</select>
				<input value={content} placeholder={t("consistency.addContent")} onChange={(event) => setContent(event.target.value)} maxLength={600} />
				<button type="button" disabled={!content.trim() || creating} onClick={() => void create()}>
					{t("consistency.create")}
				</button>
			</div>
			<div className="memory-scroll">
				<ul className="memory-list">
					{memories.map((memory) => (
						<GlobalMemoryItem key={memory.id} memory={memory} busy={pending.current.has(memory.id)} onStatus={(status) => void setStatus(memory.id, status)} />
					))}
				</ul>
			</div>
		</section>
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

function GlobalMemoryItem({ memory, busy, onStatus }: {
	memory: ProjectMemoryDTO;
	busy: boolean;
	onStatus: (status: ProjectMemoryStatus) => void;
}) {
	const { t } = useI18n();
	return (
		<li className="memory-item">
			<div className="memory-head">
				<span className={`memory-status memory-status-${memory.status}`}>
					{t(`memory.status.${memory.status}`)}
				</span>
				<span className="work-kind">{t(`memory.kind.${memory.kind}`)}</span>
			</div>
			<p className="memory-content">{memory.content}</p>
			<div className="memory-meta">
				{fmtTime(memory.createdAt)} · v{memory.version}
				{memory.occurrenceCount > 1 && <> · {t("work.memory.seen", { n: memory.occurrenceCount })}</>}
			</div>
			<div className="memory-actions">
				{MEMORY_ACTIONS[memory.status].map((action) => (
					<button key={action.status} type="button" disabled={busy} onClick={() => onStatus(action.status)}>
						{t(action.key)}
					</button>
				))}
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

function FindingsSection({ title, findings, memories, resolvable, onError, onChanged }: {
	title: string;
	findings: Array<{ finding: FindingLike; projectId?: number; projectName?: string }>;
	memories: ProjectMemoryDTO[];
	/** Global findings carry a resolution workflow; project findings are view-only. */
	resolvable?: boolean;
	onError: (message: string | null) => void;
	onChanged: () => void;
}) {
	const { t } = useI18n();
	const pending = useRef(new Set<number>());
	const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
	const open = findings.filter(({ finding }) => finding.resolution === undefined || finding.resolution === "open");
	const closed = findings.filter(({ finding }) => finding.resolution === "resolved" || finding.resolution === "dismissed");

	async function setResolution(id: number, resolution: GlobalFindingDTO["resolution"]) {
		if (pending.current.has(id)) return;
		pending.current.add(id);
		onError(null);
		try {
			await apiPost(`/api/global/findings/${id}/resolution`, { resolution });
			onChanged();
		} catch (err) {
			onError(apiErrorMessage(err));
		} finally {
			pending.current.delete(id);
		}
	}

	return (
		<section className={`board-section findings-section${open.length === 0 ? " is-empty" : ""}`}>
			<header>
				<h2>{title}</h2>
				<span className="count">{open.length}</span>
			</header>
			{open.length === 0 ? (
				<p className="muted">{t("consistency.findings.empty")}</p>
			) : (
				<ul className="memory-list">
					{open.map(({ finding, projectId, projectName }) => (
						<FindingRow
							key={`${projectId ?? "g"}-${finding.id}`}
							finding={finding}
							projectId={projectId}
							projectName={projectName}
							memoryById={memoryById}
							resolvable={resolvable}
							pending={pending.current.has(finding.id)}
							onResolve={setResolution}
						/>
					))}
				</ul>
			)}
			{closed.length > 0 && (
				<details className="closed-findings">
					<summary>{t("consistency.resolved")}/{t("consistency.dismissed")} · {closed.length}</summary>
					<ul className="memory-list">
						{closed.map(({ finding, projectId, projectName }) => (
							<FindingRow
								key={`${projectId ?? "g"}-${finding.id}`}
								finding={finding}
								projectId={projectId}
								projectName={projectName}
								memoryById={memoryById}
								resolvable={resolvable}
								dimmed
								pending={pending.current.has(finding.id)}
								onResolve={setResolution}
							/>
						))}
					</ul>
				</details>
			)}
		</section>
	);
}

function FindingRow({ finding, projectId, projectName, memoryById, resolvable, dimmed, pending, onResolve }: {
	finding: FindingLike;
	projectId?: number;
	projectName?: string;
	memoryById: Map<string, ProjectMemoryDTO>;
	resolvable?: boolean;
	dimmed?: boolean;
	pending: boolean;
	onResolve: (id: number, resolution: GlobalFindingDTO["resolution"]) => void;
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
							const label = memory
								? `${t("finding.memoryRef")} ${memory.content.slice(0, 60)}${memory.content.length > 60 ? "…" : ""}`
								: `${t("finding.memoryRef")} #${entry.memoryId.slice(0, 8)}`;
							return projectId != null ? (
								<Link key={index} className="mono" to={`/history/project/${projectId}`} title={entry.memoryId}>{label}</Link>
							) : (
								<span key={index} className="mono" title={entry.memoryId}>{label}</span>
							);
						}
						if (entry.sessionId) {
							return (
								<Link key={index} className="mono" to={`/sessions/${entry.sessionId}`} title={entry.sessionId}>
									#{entry.sessionId.slice(0, 8)}{entry.turnPosition != null ? ` @${entry.turnPosition}` : ""}
								</Link>
							);
						}
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
						<>
							<button type="button" disabled={pending} onClick={() => onResolve(finding.id, "resolved")}>
								{t("consistency.resolve")}
							</button>
							<button type="button" disabled={pending} onClick={() => onResolve(finding.id, "dismissed")}>
								{t("consistency.dismiss")}
							</button>
						</>
					) : (
						<button type="button" disabled={pending} onClick={() => onResolve(finding.id, "open")}>
							{t("consistency.reopen")}
						</button>
					)}
				</div>
			)}
		</li>
	);
}
