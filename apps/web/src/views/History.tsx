import { useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type {
	HistorySessionDTO,
	ProjectHistoryDTO,
	ProjectInspectionDTO,
	ProjectMemoryDTO,
	ProjectMemoryKind,
	ProjectMemoryStatus,
	ProjectTreeNodeDTO,
	ProjectWorkDTO,
} from "@pi-kanban/shared";
import { apiErrorMessage, apiPost, fmtCost, fmtTime, useResource } from "../api.js";
import { useI18n } from "../i18n.js";
import type { MsgKey } from "../i18n.js";
import { InspectionLogPanel } from "./InspectionLogs.js";
import { EmptyHistoryIllustration } from "../components/illustrations.js";

const EMPTY_PROJECT_COVERAGE: ProjectWorkDTO["coverage"] = {
	totalFiles: 0,
	readFiles: 0,
	highConfidenceMemories: 0,
};

const STRUCTURE_KINDS = new Set(["project", "module"]);

/** Walk the parent chain: insight nodes belong to their module ancestor, if any. */
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

export function History() {
	const { t } = useI18n();
	const { data, error, loading } = useResource<ProjectHistoryDTO[]>("/api/history");
	const projects = data ?? [];
	return (
		<div className="history">
			<header>
				<h1 className="page-title">{t("history.title")}</h1>
			</header>
			{error && <div className="error">{apiErrorMessage(error)}</div>}
			{loading && !data && <div className="empty">{t("common.loading")}</div>}
			{data && projects.length === 0 && (
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
	const [refreshKey, setRefreshKey] = useState(0);
	const [memoryFilter, setMemoryFilter] = useState<ProjectMemoryStatus | "all">("all");
	const [actionError, setActionError] = useState<string | null>(null);
	const [inspecting, setInspecting] = useState(false);
	const pendingRequests = useRef(new Set<string>());
	const [pendingMemories, setPendingMemories] = useState<Set<string>>(new Set());
	const [updatedMemories, setUpdatedMemories] = useState<Record<string, ProjectMemoryDTO>>({});
	const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
	const [showLogs, setShowLogs] = useState(false);
	const { data: sessions, error: sessionsError } = useResource<HistorySessionDTO[]>(
		id ? `/api/projects/${id}/sessions` : null,
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
	const nodeById = new Map(treeNodes.map((node) => [node.id, node]));
	const structureNodes = treeNodes.filter((node) => STRUCTURE_KINDS.has(node.kind));
	const moduleInsights = new Map<string, ProjectTreeNodeDTO[]>();
	const rootInsights: ProjectTreeNodeDTO[] = [];
	for (const node of treeNodes) {
		if (STRUCTURE_KINDS.has(node.kind)) continue;
		const moduleId = insightModuleId(node, nodeById);
		if (!moduleId) {
			rootInsights.push(node);
			continue;
		}
		const list = moduleInsights.get(moduleId) ?? [];
		list.push(node);
		moduleInsights.set(moduleId, list);
	}

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

	return (
		<div className="board-layout project-detail">
			<div className="board-main">
				<header>
					<h1 className="page-title">{t("sessions.title")}</h1>
					{work && <p className="muted">{work.project.name}</p>}
				</header>
				{sessionsError && <div className="error">{apiErrorMessage(sessionsError)}</div>}
				<div className={`project-work-main${work ? " has-tree" : ""}`}>
					{work && <TreeCard nodes={structureNodes} coverage={coverage} selectedNodeId={selectedModule?.id} onSelect={setSelectedModuleId} />}
					<div className="project-sessions">
						{!sessionsError && !sessions && <div className="empty">{t("common.loading")}</div>}
						{sessions && sessions.length === 0 && (
							<div className="empty">
								<h2>{t("sessions.empty")}</h2>
								<p>{t("sessions.emptyHint")}</p>
							</div>
						)}
						{sessions && sessions.length > 0 && (
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
												<Link to={`/sessions/${s.id}`} title={s.title ?? s.id}>{s.title ?? s.id}</Link>
											</td>
											<td className={`status-${s.state}`}>{t(`state.${s.state}` as MsgKey)}</td>
											<td>{s.turnCount}</td>
											<td>{fmtCost(s.totalCostUsd)}</td>
											<td>{fmtTime(s.startedAt)}</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
					</div>
				</div>
			</div>
			<aside className="board-rail">
				{workError && <div className="error">{apiErrorMessage(workError)}</div>}
				{!workError && !work && <div className="empty">{t("common.loading")}</div>}
				{actionError && <div className="error">{actionError}</div>}
				{work && (
					<div className="rail-group">
					<InspectionCard
						inspection={work.inspection}
						snapshotUpdatedAt={work.snapshotUpdatedAt}
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
					<MemoriesCard
						memories={memories}
						insights={rootInsights}
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

export function InspectionCard({ inspection, snapshotUpdatedAt, busy, onInspect, onLogs }: {
	inspection: ProjectInspectionDTO;
	snapshotUpdatedAt?: number;
	busy: boolean;
	onInspect: () => void;
	onLogs: () => void;
}) {
	const { t } = useI18n();
	const statusClass = inspection.running ? "state-running" : inspection.enabled ? "state-idle" : "state-offline";
	const statusLabel = inspection.running
		? t("work.inspectRunning")
		: inspection.enabled
			? t("work.inspection.enabled")
			: t("work.inspection.disabled");
	return (
		<section className="rail-card rail-group-item">
			<header>
				<h2>{t("work.inspection")}</h2>
			</header>
			<span className={`state ${statusClass}`}>{statusLabel}</span>
			<div className="card-meta">
				<span>{inspection.lastRunAt ? t("work.inspection.last", { time: fmtTime(inspection.lastRunAt) }) : t("work.inspection.never")}</span>
				{inspection.enabled && inspection.nextRunAt && (
					<span>{t("work.inspection.next", { time: fmtTime(inspection.nextRunAt) })}</span>
				)}
				{snapshotUpdatedAt && <span>{t("work.snapshot", { time: fmtTime(snapshotUpdatedAt) })}</span>}
			</div>
			{!inspection.enabled && <p className="muted work-hint">{t("work.inspection.disabledHint")}</p>}
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

const MEMORY_FILTERS: Array<ProjectMemoryStatus | "all"> = ["all", "candidate", "confirmed", "pinned", "archived"];
const MEMORY_KIND_ORDER: ProjectMemoryKind[] = ["decision", "fact", "preference", "pattern", "issue"];

export function MemoriesCard({ memories, insights, pending, filter, onFilter, onStatus }: {
	memories: ProjectMemoryDTO[];
	insights: ProjectTreeNodeDTO[];
	pending: Set<string>;
	filter: ProjectMemoryStatus | "all";
	onFilter: (filter: ProjectMemoryStatus | "all") => void;
	onStatus: (memoryId: string, status: ProjectMemoryStatus) => void;
}) {
	const { t } = useI18n();
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
			</header>
			{memories.length === 0 ? (
				<p className="muted">{t("work.memory.empty")}</p>
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
							<p className="muted">{t("work.memory.empty")}</p>
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
			<div className="memory-meta">{fmtTime(memory.createdAt)} · v{memory.version}</div>
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
						{coverage.totalFiles > 0
							? t("work.coverage.files", { read: coverage.readFiles, total: coverage.totalFiles })
							: t("work.coverage.none")}
						<span>·</span>
						{t("work.coverage.memories", { n: coverage.highConfidenceMemories })}
					</p>
				</div>
				{moduleCount > 0 && <span className="count">{moduleCount}</span>}
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
							{node.coverage && node.coverage.totalFiles > 0 && <span className="work-coverage">{t("work.coverage.files", { read: node.coverage.readFiles, total: node.coverage.totalFiles })}</span>}
							{node.detail && <p className="work-detail">{node.detail}</p>}
							<TreeLevel byParent={byParent} parentId={node.id} depth={depth + 1} selectedNodeId={selectedNodeId} onSelect={onSelect} />
						</details>
					</li>
				);
			})}
		</ul>
	);
}
