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
import { EmptyHistoryIllustration } from "../components/illustrations.js";

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
	const { data: sessions, error: sessionsError } = useResource<HistorySessionDTO[]>(
		id ? `/api/projects/${id}/sessions` : null,
	);
	const { data: work, error: workError } = useResource<ProjectWorkDTO>(
		id ? `/api/projects/${id}/work` : null,
		refreshKey,
	);

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
										<Link to={`/sessions/${s.id}`}>{s.title ?? s.id}</Link>
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
						/>
						<MemoriesCard
							memories={work.memories.map((memory) => {
								const updated = updatedMemories[memory.id];
								return updated && updated.version > memory.version ? updated : memory;
							})}
							pending={pendingMemories}
							filter={memoryFilter}
							onFilter={setMemoryFilter}
							onStatus={(memoryId, status) => void setStatus(memoryId, status)}
						/>
						<TreeCard nodes={work.tree} />
					</div>
				)}
			</aside>
		</div>
	);
}

export function InspectionCard({ inspection, snapshotUpdatedAt, busy, onInspect }: {
	inspection: ProjectInspectionDTO;
	snapshotUpdatedAt?: number;
	busy: boolean;
	onInspect: () => void;
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
			<button type="button" disabled={busy || inspection.running} onClick={onInspect}>
				{inspection.running || busy ? t("work.inspectRunning") : t("work.inspect")}
			</button>
		</section>
	);
}

const MEMORY_FILTERS: Array<ProjectMemoryStatus | "all"> = ["all", "candidate", "confirmed", "pinned", "archived"];
const MEMORY_KIND_ORDER: ProjectMemoryKind[] = ["decision", "fact", "preference", "pattern", "issue"];

export function MemoriesCard({ memories, pending, filter, onFilter, onStatus }: {
	memories: ProjectMemoryDTO[];
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
						{filtered.length === 0 ? (
							<p className="muted">{t("work.memory.empty")}</p>
						) : (
							groups.map((group) => (
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
							))
						)}
					</div>
				</>
			)}
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

function TreeCard({ nodes }: { nodes: ProjectTreeNodeDTO[] }) {
	const { t } = useI18n();
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
		<section className="board-section rail-group-item tree-section">
			<header>
				<h2>{t("work.tree")}</h2>
				<span className="count">{nodes.length}</span>
			</header>
			{nodes.length === 0 ? (
				<p className="muted">{t("work.tree.empty")}</p>
			) : (
				<TreeLevel byParent={byParent} parentId={null} />
			)}
		</section>
	);
}

function TreeLevel({ byParent, parentId }: { byParent: Map<string | null, ProjectTreeNodeDTO[]>; parentId: string | null }) {
	const { t } = useI18n();
	const children = byParent.get(parentId) ?? [];
	if (children.length === 0) return null;
	return (
		<ul className="work-tree">
			{children.map((node) => (
				<li key={node.id}>
					<div className={`work-node severity-${node.severity ?? "info"}`}>
						<span className="work-kind">{t(`tree.kind.${node.kind}` as MsgKey)}</span>
						{node.sessionId ? (
							<Link className="work-label" to={`/sessions/${node.sessionId}`} title={node.sessionId}>
								{node.label}
							</Link>
						) : (
							<span className="work-label">{node.label}</span>
						)}
					</div>
					{node.detail && <p className="work-detail">{node.detail}</p>}
					<TreeLevel byParent={byParent} parentId={node.id} />
				</li>
			))}
		</ul>
	);
}
