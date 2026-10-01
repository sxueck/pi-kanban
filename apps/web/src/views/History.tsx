import { useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type {
	HistorySessionDTO,
	ProjectHistoryDTO,
	ProjectInspectionDTO,
	ProjectMemoryDTO,
	ProjectMemoryKind,
	ProjectMemoryStatus,
	ProjectTreeNodeDTO,
	ProjectWorkDTO,
	SessionFindingDTO,
} from "@pi-kanban/shared";
import { MIN_INSPECTION_SESSIONS } from "@pi-kanban/shared";
import { apiDelete, apiDownload, apiErrorMessage, apiPost, fmtAgo, fmtCost, fmtTime, fmtUntil, useResource } from "../api.js";
import { useI18n } from "../i18n.js";
import type { MsgKey } from "../i18n.js";
import { InspectionLogPanel } from "./InspectionLogs.js";
import { EmptyHistoryIllustration } from "../components/illustrations.js";
import { EmptyState, ErrorState, Skeleton, SkeletonCards, SkeletonRows } from "../components/states.js";
import { StateIcon } from "../components/icons.js";

const EMPTY_PROJECT_COVERAGE: ProjectWorkDTO["coverage"] = {
	totalFiles: 0,
	readFiles: 0,
	highConfidenceMemories: 0,
};

const STRUCTURE_KINDS = new Set(["project", "module"]);
const PROJECT_TREE_KINDS = new Set(["project", "module", "file"]);

function insightModuleId(node: ProjectTreeNodeDTO, byId: Map<string, ProjectTreeNodeDTO>): string | undefined {
	let cursor = node.parentId;
	while (cursor) {
		const parent = byId.get(cursor);
		if (!parent || parent.kind === "project") return undefined;
		if (parent.kind === "module") return parent.id;
		cursor = parent.parentId;
	}
	return undefined;
}

export function partitionProjectTree(treeNodes: ProjectTreeNodeDTO[]) {
	const nodeById = new Map(treeNodes.map((node) => [node.id, node]));
	const structureNodes = treeNodes.filter((node) => STRUCTURE_KINDS.has(node.kind));
	const moduleInsights = new Map<string, ProjectTreeNodeDTO[]>();
	const rootInsights: ProjectTreeNodeDTO[] = [];
	for (const node of treeNodes) {
		if (PROJECT_TREE_KINDS.has(node.kind)) continue;
		const moduleId = insightModuleId(node, nodeById);
		if (!moduleId) {
			rootInsights.push(node);
			continue;
		}
		const list = moduleInsights.get(moduleId) ?? [];
		list.push(node);
		moduleInsights.set(moduleId, list);
	}
	return { structureNodes, moduleInsights, rootInsights };
}

export function History() {
	const { t, locale } = useI18n();
	const [refreshKey, setRefreshKey] = useState(0);
	const { data, error, loading } = useResource<ProjectHistoryDTO[]>("/api/history", refreshKey);
	const projects = data ?? [];
	return (
		<div className="history">
			<header className="page-head">
				<div>
					<p className="page-eyebrow">{t("nav.history")}</p>
					<h1 className="page-title">{t("history.title")}</h1>
					<p>{t("history.subtitle")}</p>
				</div>
			</header>
			{error && <ErrorState error={error} onRetry={() => setRefreshKey((k) => k + 1)} />}
			{loading && !data && <SkeletonCards count={6} min={3} />}
			{data && projects.length === 0 && (
				<EmptyState
					illustration={<EmptyHistoryIllustration />}
					title={t("history.empty")}
					hint={t("history.emptyHint")}
				/>
			)}
			<div className="cards">
				{projects.map((p, i) => (
					<Link
						key={p.id}
						to={`/history/project/${p.id}`}
						className="card project-card"
						style={{ "--i": i } as React.CSSProperties}
					>
						<div className="card-title">{p.name}</div>
						{p.gitRemote && <div className="mono muted project-remote">{p.gitRemote}</div>}
						<div className="card-meta">
							<span>{t("history.sessions", { n: p.sessionCount })}</span>
							<span>{fmtCost(p.totalCostUsd)}</span>
							{p.lastActivityAt && (
								<span title={fmtTime(p.lastActivityAt)}>{t("history.last", { time: fmtAgo(p.lastActivityAt, locale) })}</span>
							)}
						</div>
						<span className="card-go" aria-hidden="true">→</span>
					</Link>
				))}
			</div>
		</div>
	);
}

export function ProjectSessions() {
	const { t, locale } = useI18n();
	const navigate = useNavigate();
	const [refreshKey, setRefreshKey] = useState(0);
	const [memoryFilter, setMemoryFilter] = useState<ProjectMemoryStatus | "all">("all");
	const [actionError, setActionError] = useState<string | null>(null);
	const [inspecting, setInspecting] = useState(false);
	const pendingRequests = useRef(new Set<string>());
	const [pendingMemories, setPendingMemories] = useState<Set<string>>(new Set());
	const [updatedMemories, setUpdatedMemories] = useState<Record<string, ProjectMemoryDTO>>({});
	const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
	const [showLogs, setShowLogs] = useState(false);
	const { id } = useParams<{ id: string }>();
	const { data: sessions, error: sessionsError } = useResource<HistorySessionDTO[]>(
		id ? `/api/projects/${id}/sessions` : null,
		refreshKey,
	);
	const { data: work, error: workError } = useResource<ProjectWorkDTO>(
		id ? `/api/projects/${id}/work` : null,
		refreshKey,
	);
	const memories = work?.memories.map((memory) => {
		const updated = updatedMemories[memory.id];
		return updated && updated.version > memory.version ? updated : memory;
	}) ?? [];
	const coverage = work?.coverage ?? EMPTY_PROJECT_COVERAGE;
	const selectedModule = work?.tree.find((node) => node.id === selectedModuleId && node.kind === "module");
	// The tree card shows structure only; inspection insights surface in module
	// details, or in the memories card when they are not linked to any module.
	const treeNodes = work?.tree ?? [];
	const { structureNodes, moduleInsights, rootInsights } = partitionProjectTree(treeNodes);

	async function setStatus(memoryId: string, status: ProjectMemoryStatus) {
		if (!id || pendingRequests.current.has(memoryId)) return;
		pendingRequests.current.add(memoryId);
		setPendingMemories(new Set(pendingRequests.current));
		setActionError(null);
		try {
			const updated = await apiPost<ProjectMemoryDTO>(`/api/projects/${id}/memories/${memoryId}/status`, { status });
			setUpdatedMemories((current) => ({ ...current, [memoryId]: updated }));
			setRefreshKey((key) => key + 1);
		} catch (err) {
			setActionError(apiErrorMessage(err));
		} finally {
			pendingRequests.current.delete(memoryId);
			setPendingMemories(new Set(pendingRequests.current));
		}
	}

	async function inspectNow() {
		if (!id) return;
		setActionError(null);
		setInspecting(true);
		try {
			await apiPost(`/api/projects/${id}/inspect`, {});
			setRefreshKey((key) => key + 1);
		} catch (err) {
			setActionError(apiErrorMessage(err));
		} finally {
			setInspecting(false);
		}
	}

	async function clearEmptySessions() {
		if (!id || !window.confirm(t("sessions.clearEmptyConfirm"))) return;
		setActionError(null);
		try {
			await apiPost(`/api/projects/${id}/clear-empty-sessions`, {});
			setRefreshKey((key) => key + 1);
		} catch (err) {
			setActionError(apiErrorMessage(err));
		}
	}

	async function deleteProject() {
		if (!id || !window.confirm(t("sessions.deleteConfirm"))) return;
		setActionError(null);
		try {
			await apiDelete(`/api/projects/${id}`);
			navigate("/history");
		} catch (err) {
			setActionError(apiErrorMessage(err));
		}
	}

	return (
		<div className="board-layout project-detail">
			<div className="board-main">
				<header className="page-head">
				<div>
					<p className="page-eyebrow"><Link to="/history">{t("nav.history")}</Link></p>
					<h1 className="page-title">{work ? work.project.name : t("sessions.title")}</h1>
					{work && (
						<p>
							{t("sessions.count", { n: sessions?.length ?? 0 })}
							{work.project.gitRemote && <> · <span className="mono">{work.project.gitRemote}</span></>}
						</p>
					)}
				</div>
				{work && (
					<div className="project-maintenance">
						<button type="button" className="secondary" onClick={() => void clearEmptySessions()}>{t("sessions.clearEmpty")}</button>
						<button type="button" className="danger" onClick={() => void deleteProject()}>{t("sessions.delete")}</button>
					</div>
				)}
			</header>
			{sessionsError && <ErrorState error={sessionsError} onRetry={() => setRefreshKey((k) => k + 1)} />}
			{actionError && <ErrorState error={actionError} />}
			<div className={`project-work-main${work ? " has-tree" : ""}`}>
				{work && <TreeCard nodes={structureNodes} coverage={coverage} selectedNodeId={selectedModule?.id} onSelect={setSelectedModuleId} />}
				<div className="project-sessions">
					{!sessionsError && !sessions && <SkeletonRows count={6} />}
					{sessions && sessions.length === 0 && (
						<EmptyState title={t("sessions.empty")} hint={t("sessions.emptyHint")} />
					)}
					{sessions && sessions.length > 0 && (
						<table className="table">
							<caption className="sr-only">{t("sessions.title")}</caption>
							<thead>
								<tr>
									<th scope="col">{t("th.title")}</th>
									<th scope="col">{t("th.state")}</th>
									<th scope="col">{t("th.turns")}</th>
									<th scope="col">{t("th.cost")}</th>
									<th scope="col">{t("th.started")}</th>
								</tr>
							</thead>
							<tbody>
								{sessions.map((s) => (
									<tr key={s.id}>
										<td>
											<Link to={`/sessions/${s.id}`} title={s.title ?? s.id}>{s.title ?? t("board.untitled")}</Link>
										</td>
										<td className={`state-cell is-${s.state} nowrap`}>
											<StateIcon state={s.state} />{t(`state.${s.state}` as MsgKey)}
										</td>
										<td className="nowrap">{s.turnCount}</td>
										<td className="nowrap">{fmtCost(s.totalCostUsd)}</td>
										<td className="nowrap" title={fmtTime(s.startedAt)}>{fmtAgo(s.startedAt, locale)}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>
			</div>
		</div>
		<aside className="board-rail" aria-busy={!work && !workError}>
			{workError && <ErrorState error={workError} onRetry={() => setRefreshKey((k) => k + 1)} />}
			{!workError && !work && (
				<div className="rail-group" aria-hidden="true">
					<Skeleton style={{ height: 130, borderRadius: "var(--radius)" }} />
					<Skeleton style={{ height: 240, borderRadius: "var(--radius)" }} />
				</div>
			)}
				{work && (
					<div className="rail-group">
					<InspectionCard
						inspection={work.inspection}
						busy={inspecting}
						onInspect={() => void inspectNow()}
						onLogs={() => setShowLogs(true)}
					/>
					{selectedModule && (
						<ModuleDetails
							node={selectedModule}
							insights={moduleInsights.get(selectedModule.id) ?? []}
							memories={memories}
							sessions={sessions ?? []}
							pending={pendingMemories}
							onStatus={setStatus}
						/>
					)}
					<FindingsCard findings={work.findings} memories={memories} />
					<MemoriesCard
						memories={memories}
						insights={rootInsights}
						projectId={work.project.id}
						pending={pendingMemories}
						filter={memoryFilter}
						onFilter={setMemoryFilter}
						onStatus={(memoryId, status) => void setStatus(memoryId, status)}
					/>
				</div>
			)}
			</aside>
			{showLogs && work && (
				<InspectionLogPanel projectId={work.project.id} onClose={() => setShowLogs(false)} />
			)}
		</div>
	);
}

export function InspectionCard({ inspection, busy, onInspect, onLogs }: {
	inspection: ProjectInspectionDTO;
	busy: boolean;
	onInspect: () => void;
	onLogs: () => void;
}) {
	const { t, locale } = useI18n();
	const failed = Boolean(inspection.lastError) && !inspection.running;
	const statusClass = inspection.running
		? "state-running"
		: failed
			? "state-error"
			: inspection.enabled && !inspection.excluded ? "state-idle" : "state-offline";
	const statusLabel = inspection.running
		? t("work.inspectRunning")
		: inspection.excluded
			? t("work.inspection.excluded")
			: inspection.enabled
				? failed
					? t("work.inspection.failed")
					: t("work.inspection.enabled")
				: t("work.inspection.disabled");
	return (
		<section className="rail-card rail-group-item inspection-card">
			<header>
				<h2>{t("work.inspection")}</h2>
			</header>
			<span className={`state ${statusClass}`}>{statusLabel}</span>
			<div className="card-meta">
				{inspection.lastRunAt ? (
					<span title={fmtTime(inspection.lastRunAt)}>{t("work.inspection.last", { time: fmtAgo(inspection.lastRunAt, locale) })}</span>
				) : (
					<span>{t("work.inspection.never")}</span>
				)}
				{inspection.enabled && !inspection.excluded && !inspection.running && inspection.nextRunAt && (
					<span title={fmtTime(inspection.nextRunAt)}>{t("work.inspection.next", { time: fmtUntil(inspection.nextRunAt, locale) })}</span>
				)}
			</div>
			{!inspection.enabled && <p className="muted work-hint">{t("work.inspection.disabledHint")}</p>}
			{inspection.enabled && !inspection.excluded && inspection.sessionCount < MIN_INSPECTION_SESSIONS && (
				<p className="muted work-hint">{t("work.inspection.lowSessions", { n: MIN_INSPECTION_SESSIONS })}</p>
			)}
			{!inspection.running && !busy && inspection.lastError && (
				<p className="error work-hint">{inspection.lastError}<br />{t("work.inspection.retryHint")}</p>
			)}
			<div className="inspection-actions">
				<button type="button" disabled={busy || inspection.running} onClick={onInspect}>
					{inspection.running || busy ? t("work.inspectRunning") : t("work.inspect")}
				</button>
				<button type="button" className="secondary" onClick={onLogs}>
					{t("work.logs")}
				</button>
			</div>
		</section>
	);
}



const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

export function FindingsCard({ findings, memories = [] }: { findings: SessionFindingDTO[]; memories?: ProjectMemoryDTO[] }) {
	const { t } = useI18n();
	const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
	// One severity-first list: five ALL-CAPS group headers in a 320px rail bury
	// the two findings that actually matter.
	const ordered = [...findings].sort(
		(a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.lastSeenAt - a.lastSeenAt,
	);
	return (
		<section className={`board-section rail-group-item memories-section findings-section${findings.length === 0 ? " is-empty" : ""}`}>
			<header>
				<h2>{t("work.findings")}</h2>
				<span className="count">{findings.length}</span>
			</header>
			{findings.length === 0 ? (
				<p className="muted">{t("work.findings.empty")}</p>
			) : (
				<div className="memory-scroll">
					<ul className="memory-list">
						{ordered.map((finding) => (
							<FindingItem key={finding.id} finding={finding} memoryById={memoryById} />
						))}
					</ul>
				</div>
			)}
		</section>
	);
}

function FindingItem({ finding, memoryById }: { finding: SessionFindingDTO; memoryById: Map<string, ProjectMemoryDTO> }) {
	const { t, locale } = useI18n();
	return (
		<li className={`insight-item severity-${finding.severity}`}>
			<div className="insight-head">
				<span className="finding-kind">{t(`finding.kind.${finding.kind}` as MsgKey)}</span>
				{finding.sessionId ? (
					<Link className="insight-label" to={`/sessions/${finding.sessionId}`} title={finding.sessionId}>
						{finding.summary}
					</Link>
				) : (
					<span className="insight-label">{finding.summary}</span>
				)}
			</div>
			{finding.detail && <p className="work-detail">{finding.detail}</p>}
			{finding.evidence.some((entry) => entry.memoryId) && (
				<div className="memory-evidence">
					{finding.evidence.flatMap((entry, index) => {
						if (!entry.memoryId) return [];
						const memory = memoryById.get(entry.memoryId);
						const label = memory
							? `${t("finding.memoryRef")} ${memory.content.slice(0, 60)}${memory.content.length > 60 ? "…" : ""}`
							: `${t("finding.memoryRef")} #${entry.memoryId.slice(0, 8)}`;
						return [<span key={index} className="mono" title={entry.memoryId}>{label}</span>];
					})}
				</div>
			)}
			<div className="memory-meta">
				<span title={fmtTime(finding.createdAt)}>{fmtAgo(finding.createdAt, locale)}</span>
				{finding.occurrenceCount > 1 && <> · {t("finding.seen", { n: finding.occurrenceCount })} · {t("finding.lastSeen", { time: fmtAgo(finding.lastSeenAt, locale) })}</>}
			</div>
		</li>
	);
}

const MEMORY_FILTERS: Array<ProjectMemoryStatus | "all"> = ["all", "candidate", "confirmed", "pinned", "archived"];
const MEMORY_KIND_ORDER: ProjectMemoryKind[] = ["decision", "fact", "preference", "pattern", "issue"];

export function MemoriesCard({ memories, insights, projectId, pending, filter, onFilter, onStatus }: {
	memories: ProjectMemoryDTO[];
	insights: ProjectTreeNodeDTO[];
	projectId: number;
	pending: Set<string>;
	filter: ProjectMemoryStatus | "all";
	onFilter: (filter: ProjectMemoryStatus | "all") => void;
	onStatus: (memoryId: string, status: ProjectMemoryStatus) => void;
}) {
	const { t } = useI18n();
	const [exporting, setExporting] = useState(false);
	const [exportDone, setExportDone] = useState(false);
	const [exportError, setExportError] = useState<string | null>(null);
	async function exportReferenceRules() {
		setExporting(true);
		setExportDone(false);
		setExportError(null);
		try {
			await apiDownload(`/api/projects/${projectId}/memories/reference-rules`, `PROJECT-RULE-SUGGESTIONS-${projectId}.md`);
			setExportDone(true);
		} catch (err) {
			setExportError(apiErrorMessage(err));
		} finally {
			setExporting(false);
		}
	}
	const filtered = (filter === "all" ? [...memories] : memories.filter((m) => m.status === filter))
		.sort((a, b) => Number(b.status === "pinned") - Number(a.status === "pinned") || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
	const groups = useMemo(() => {
		const byKind = new Map<ProjectMemoryKind, ProjectMemoryDTO[]>();
		for (const memory of filtered) {
			const list = byKind.get(memory.kind) ?? [];
			list.push(memory);
			byKind.set(memory.kind, list);
		}
		const ordered = MEMORY_KIND_ORDER.filter((kind) => byKind.has(kind)).map((kind) => ({ kind, items: byKind.get(kind)! }));
		const known = new Set(MEMORY_KIND_ORDER);
		for (const [kind, items] of byKind) {
			if (!known.has(kind)) ordered.push({ kind, items });
		}
		return ordered;
	}, [filtered]);
	const chips = MEMORY_FILTERS.map((value) => ({
		value,
		label: value === "all" ? t("work.memory.all") : t(`memory.status.${value}` as MsgKey),
		count: value === "all" ? memories.length : memories.filter((m) => m.status === value).length,
	}));
	return (
		<section className={`board-section rail-group-item memories-section${memories.length === 0 ? " is-empty" : ""}`}>
			<header>
				<h2>{t("work.memories")}</h2>
				<span className="count">{memories.length}</span>
				<button
					type="button"
					className="secondary memory-export"
					disabled={exporting || memories.length === 0}
					title={exportDone ? t("work.memory.exported") : undefined}
					onClick={() => void exportReferenceRules()}
				>
					{exportDone ? t("work.memory.exported") : t("work.memory.export")}
				</button>
			</header>
			{exportError && <div className="error" role="alert">{exportError}</div>}
			{memories.length === 0 && insights.length === 0 ? (
				<div className="empty-inline">
					<p>{t("work.memory.empty")}</p>
					<p className="work-hint">{t("work.memory.emptyHint")}</p>
				</div>
			) : (
				<>
					<div className="board-chips" role="group" aria-label={t("work.memory.filter")}>
						{chips.map((chip) => (
							<button
								key={chip.value}
								type="button"
								className={filter === chip.value ? "on" : ""}
								aria-pressed={filter === chip.value}
								onClick={() => onFilter(chip.value)}
							>
								{chip.label}
								<span className="chip-count">{chip.count}</span>
							</button>
						))}
					</div>
					<div className="memory-scroll">
						{filtered.length === 0 && insights.length === 0 ? (
							<p className="muted">{t("work.memory.emptyFiltered")}</p>
						) : (
							<>
							{groups.map((group) => (
								<div key={group.kind} className="memory-group">
									<h3 className="memory-group-title">
										{t(`memory.kind.${group.kind}` as MsgKey)}
										<span className="count">{group.items.length}</span>
									</h3>
									<ul className="memory-list">
										{group.items.map((memory) => (
											<MemoryItem key={memory.id} memory={memory} busy={pending.has(memory.id)} onStatus={onStatus} />
										))}
									</ul>
								</div>
							))}
							{insights.length > 0 && (
								<div className="memory-group">
									<h3 className="memory-group-title">
										{t("work.insights")}
										<span className="count">{insights.length}</span>
									</h3>
									<ul className="memory-list insight-list">
										{insights.map((node) => (
											<InsightItem key={node.id} node={node} />
										))}
									</ul>
								</div>
							)}
							</>
						)}
					</div>
				</>
			)}
		</section>
	);
}

function InsightItem({ node }: { node: ProjectTreeNodeDTO }) {
	const { t } = useI18n();
	return (
		<li className={`insight-item severity-${node.severity ?? "info"}`}>
			<div className="insight-head">
				<span className="work-kind">{t(`tree.kind.${node.kind}` as MsgKey)}</span>
				{node.sessionId ? (
					<Link className="insight-label" to={`/sessions/${node.sessionId}`} title={node.sessionId}>
						{node.label}
					</Link>
				) : (
					<span className="insight-label">{node.label}</span>
				)}
			</div>
			{node.detail && <p className="work-detail">{node.detail}</p>}
		</li>
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

function MemoryItem({ memory, busy, onStatus }: { memory: ProjectMemoryDTO; busy: boolean; onStatus: (id: string, status: ProjectMemoryStatus) => void }) {
	const { t } = useI18n();
	return (
		<li className="memory-item">
			<div className="memory-head">
				<span className={`memory-status memory-status-${memory.status}`}>
					{t(`memory.status.${memory.status}` as MsgKey)}
				</span>
			</div>
			<p className="memory-content">{memory.content}</p>
			<div className="memory-meta">
				{fmtTime(memory.createdAt)} · v{memory.version}
				{memory.occurrenceCount > 1 && <> · {t("work.memory.seen", { n: memory.occurrenceCount })} · {t("work.memory.lastSeen", { time: fmtTime(memory.lastSeenAt) })}</>}
			</div>
			{memory.evidence.length > 0 && (
				<div className="memory-evidence">
					<span className="muted">{t("memory.evidence")}</span>
					{memory.evidence.map((e) => (
						<Link
							key={`${e.sessionId}:${e.turnPosition ?? ""}`}
							className="mono"
							to={`/sessions/${e.sessionId}`}
							title={e.sessionId}
						>
							#{e.sessionId.slice(0, 8)}{e.turnPosition != null ? ` @${e.turnPosition}` : ""}
						</Link>
					))}
				</div>
			)}
			<div className="memory-actions">
				{MEMORY_ACTIONS[memory.status].map((action) => (
					<button key={action.status} type="button" disabled={busy} onClick={() => onStatus(memory.id, action.status)}>
						{t(action.key)}
					</button>
				))}
			</div>
		</li>
	);
}

export function ModuleDetails({ node, insights, memories, sessions, pending, onStatus }: {
	node: ProjectTreeNodeDTO;
	insights: ProjectTreeNodeDTO[];
	memories: ProjectMemoryDTO[];
	sessions: HistorySessionDTO[];
	pending: Set<string>;
	onStatus: (memoryId: string, status: ProjectMemoryStatus) => void;
}) {
	const { t } = useI18n();
	const linkedMemories = memories.filter((memory) => Array.isArray(memory.moduleIds) && memory.moduleIds.includes(node.id));
	const sessionById = new Map(sessions.map((session) => [session.id, session]));
	const linkedSessions = [...new Set(linkedMemories.flatMap((memory) => memory.evidence.map((evidence) => evidence.sessionId)))]
		.flatMap((sessionId) => {
			const session = sessionById.get(sessionId);
			return session ? [session] : [];
		});
	return (
		<section className="rail-card rail-group-item module-details">
			<header>
				<h2>{t("module.details")}</h2>
			</header>
			<p className="module-name">{node.label}</p>
			{linkedMemories.length === 0 && insights.length === 0 && <p className="muted">{t("module.empty")}</p>}
			{linkedSessions.length > 0 && (
				<div className="module-section">
					<h3>{t("module.sessions")}</h3>
					<div className="memory-evidence">
						{linkedSessions.map((session) => (
							<Link key={session.id} className="mono" to={`/sessions/${session.id}`} title={session.id}>
								{session.title ?? `#${session.id.slice(0, 8)}`}
							</Link>
						))}
					</div>
				</div>
			)}
			{linkedMemories.length > 0 && (
				<div className="module-section">
					<h3>{t("module.memories")}</h3>
					<ul className="memory-list">
						{linkedMemories.map((memory) => (
							<MemoryItem key={memory.id} memory={memory} busy={pending.has(memory.id)} onStatus={onStatus} />
						))}
					</ul>
				</div>
			)}
			{insights.length > 0 && (
				<div className="module-section">
					<h3>{t("work.insights")}</h3>
					<ul className="memory-list insight-list">
						{insights.map((insight) => (
							<InsightItem key={insight.id} node={insight} />
						))}
					</ul>
				</div>
			)}
		</section>
	);
}

function TreeCard({ nodes, coverage, selectedNodeId, onSelect }: {
	nodes: ProjectTreeNodeDTO[];
	coverage: ProjectWorkDTO["coverage"];
	selectedNodeId?: string;
	onSelect: (nodeId: string) => void;
}) {
	const { t } = useI18n();
	const moduleCount = nodes.reduce((total, node) => total + (node.kind === "module" ? 1 : 0), 0);
	// Bucket once; parents missing from the payload collapse to the root level.
	const byParent = useMemo(() => {
		const ids = new Set(nodes.map((n) => n.id));
		const map = new Map<string | null, ProjectTreeNodeDTO[]>();
		for (const node of nodes) {
			const key = node.parentId && ids.has(node.parentId) ? node.parentId : null;
			const list = map.get(key) ?? [];
			list.push(node);
			map.set(key, list);
		}
		return map;
	}, [nodes]);
	return (
		<section className="board-section tree-section tree-explorer" aria-label={t("work.tree")}>
			<header>
				<div>
					<h2>{t("work.tree")}</h2>
					<p className="tree-coverage-summary">
						{t("work.coverage.memories", { n: coverage.highConfidenceMemories })}
					</p>
				</div>
			</header>
			<div className="tree-explorer-scroll">
				{moduleCount === 0 ? (
					<p className="muted">{t("work.tree.empty")}</p>
				) : (
					<TreeLevel byParent={byParent} parentId={null} selectedNodeId={selectedNodeId} onSelect={onSelect} />
				)}
			</div>
		</section>
	);
}

function TreeLevel({ byParent, parentId, depth = 0, selectedNodeId, onSelect }: {
	byParent: Map<string | null, ProjectTreeNodeDTO[]>;
	parentId: string | null;
	depth?: number;
	selectedNodeId?: string;
	onSelect: (nodeId: string) => void;
}) {
	const { t } = useI18n();
	const children = byParent.get(parentId) ?? [];
	if (children.length === 0) return null;
	return (
		<ul className="work-tree">
			{children.map((node) => {
				const kids = byParent.get(node.id) ?? [];
				return (
					<li key={node.id}>
						{/* one folder level below the project root starts collapsed */}
						<details open={depth !== 1}>
							<summary
								className={`work-node severity-${node.severity ?? "info"}${selectedNodeId === node.id ? " is-selected" : ""}`}
								aria-current={selectedNodeId === node.id ? "true" : undefined}
								onClick={() => { if (node.kind === "module") onSelect(node.id); }}
							>
								<span className={`tree-twisty${kids.length > 0 ? "" : " is-leaf"}`} aria-hidden="true" />
								<span className="work-kind">{t(`tree.kind.${node.kind}` as MsgKey)}</span>
								{node.sessionId ? (
									<Link className="work-label" to={`/sessions/${node.sessionId}`} title={node.sessionId} onClick={(event) => event.stopPropagation()}>
										{node.label}
									</Link>
								) : (
									<span className="work-label">{node.label}</span>
								)}
							</summary>
							{node.fileCount != null && <p className="work-detail">{t("work.tree.files", { n: node.fileCount })}</p>}
							{node.detail && <p className="work-detail">{node.detail}</p>}
							<TreeLevel byParent={byParent} parentId={node.id} depth={depth + 1} selectedNodeId={selectedNodeId} onSelect={onSelect} />
						</details>
					</li>
				);
			})}
		</ul>
	);
}
