import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { MessageDTO, SessionDetailDTO, ToolCallDTO, TurnDTO } from "@pi-kanban/shared";
import { fmtCost, fmtElapsed, fmtTime, useResource } from "../api.js";
import { useI18n } from "../i18n.js";
import type { MsgKey } from "../i18n.js";
import { StateIcon } from "../components/icons.js";

export function SessionDetail() {
	const { id } = useParams<{ id: string }>();
	const { t } = useI18n();
	const { data, error, loading } = useResource<SessionDetailDTO>(
		id ? `/api/sessions/${id}` : null,
	);
	if (error) return <div className="error">{String(error)}</div>;
	if (loading && !data) return <div className="empty">loading…</div>;
	if (!data) return null;
	const s = data;
	const pendingCount = s.approvals.filter((a) => a.status === "pending").length;
	const totalTokens = s.totalTokens ?? 0;

	return (
		<div className="session-detail">
			<header className="detail-head">
				<Link to="/" className="back">
					← {t("nav.board")}
				</Link>
				<div className="project">
					{s.projectName}
					{s.branch && <span className="branch">{s.branch}</span>}
					<span className={`state state-${s.state}`}>{t(`state.${s.state}` as MsgKey)}</span>
				</div>
				<h2>{s.title ?? s.id}</h2>
				<div className="card-meta">
					<span>{t("detail.started", { time: fmtTime(s.startedAt) })}</span>
					<span>{t("detail.active", { elapsed: fmtElapsed(s.startedAt, s.lastActivityAt) })}</span>
					<span>{t("detail.turns", { n: s.turns.length })}</span>
					<span>{fmtCost(s.totalCostUsd)}</span>
					{totalTokens > 0 && <span>{fmtTokens(totalTokens)} tokens</span>}
					{s.modelId && <span className="mono">{s.modelId}</span>}
					<span className="mono muted">{s.cwd}</span>
				</div>
			</header>

			{pendingCount > 0 && (
				<section className="approval-banner">
					<StateIcon state="waiting_approval" />
					<Link to="/approvals">{t("detail.banner", { n: pendingCount })}</Link>
				</section>
			)}

			{s.todos.length > 0 && (
				<section>
					<h3>{t("detail.todos")}</h3>
					<ul className="todos">
						{s.todos.map((todo) => (
							<li key={todo.position} className={`todo-${todo.state}`}>
								<span className="todo-checkbox">{checkbox(todo.state)}</span> {todo.content}
							</li>
						))}
					</ul>
				</section>
			)}

			{s.approvals.length > 0 && (
				<section>
					<h3>{t("detail.approvals")}</h3>
					<table className="table">
						<thead>
							<tr>
								<th>{t("th.when")}</th>
								<th>{t("th.policy")}</th>
								<th>{t("th.tool")}</th>
								<th>{t("th.state")}</th>
								<th>{t("th.by")}</th>
							</tr>
						</thead>
						<tbody>
							{s.approvals.map((a) => (
								<tr key={a.id}>
									<td>{fmtTime(a.requestedAt)}</td>
									<td>{a.policyLabel}</td>
									<td className="mono">{a.toolName}</td>
									<td className={`status-${a.status}`}>{a.status}</td>
									<td>{a.decidedBy ?? (a.status === "local_resolved" ? t("approvals.localTui") : "—")}</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>
			)}

			<section className="trace-section">
				<TraceView session={s} />
			</section>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Trace view — DSH-style: toolbar + timing overview + event ledger
// ---------------------------------------------------------------------------

type TraceViewMode = "turns" | "calls";

/** One record in the ledger: either a message or a tool call. */
type MessageRecord = {
	kind: "user" | "assistant" | "context";
	at: number;
	message: MessageDTO;
	/** True for the turn-header prompt row synthesized from the turn itself. */
	syntheticPrompt?: boolean;
};

type ToolRecord = { kind: "tool"; at: number; tool: ToolCallDTO };

type TraceRecord = MessageRecord | ToolRecord;

function recordKind(m: MessageDTO): MessageRecord["kind"] {
	if (m.role === "user") return "user";
	if (m.role === "assistant") return "assistant";
	return "context";
}

/** A renderable group: early orphans, or one turn. */
type Group = {
	/** DOM anchor for timeline navigation. */
	anchor: string;
	/** Legend label, e.g. "Turn 3 · 1.2s" or "System · init". */
	label: string;
	/** Prompt shown in the legend (turns only). */
	prompt?: string;
	/** Sequential display number within this session. */
	ordinal?: number;
	turn?: TurnDTO;
	records: TraceRecord[];
};

function buildGroups(turns: TurnDTO[], messages: MessageDTO[], tools: ToolCallDTO[], t: ReturnType<typeof useI18n>["t"]): {
	groups: Group[];
	flat: TraceRecord[];
} {
	const turnPositions = new Set(turns.map((turn) => turn.position));
	const orphanMessages = messages.filter(
		(m) => (m.turnPosition == null || !turnPositions.has(m.turnPosition)) && m.role !== "user",
	);
	const orphanTools = tools.filter((tool) => tool.turnPosition == null || !turnPositions.has(tool.turnPosition));

	const groups: Group[] = [];
	if (orphanMessages.length + orphanTools.length > 0) {
		const records: TraceRecord[] = [
			...orphanMessages.map((m): MessageRecord => ({ kind: recordKind(m), at: m.timestamp, message: m })),
			...orphanTools.map((tl): ToolRecord => ({ kind: "tool", at: tl.startedAt, tool: tl })),
		].sort((a, b) => a.at - b.at);
		groups.push({ anchor: "trace-early", label: t("trace.systemInit"), records });
	}

	for (const [i, turn] of turns.entries()) {
		const turnMessages = messages.filter((m) => m.turnPosition === turn.position);
		const turnTools = tools.filter((tool) => tool.turnPosition === turn.position);
		const records: TraceRecord[] = [
			// the turn header already shows the prompt; drop the duplicate user record
			...turnMessages
				.filter((m) => !(m.role === "user" && m.excerpt === turn.prompt))
				.map((m): MessageRecord => ({ kind: recordKind(m), at: m.timestamp, message: m })),
			...turnTools.map((tl): ToolRecord => ({ kind: "tool", at: tl.startedAt, tool: tl })),
		].sort((a, b) => a.at - b.at);
		if (turn.prompt) {
			const promptRecord: MessageRecord = {
				kind: "user",
				at: turn.startedAt,
				message: syntheticPrompt(turn),
				syntheticPrompt: true,
			};
			records.unshift(promptRecord);
		}
		const end = turn.endedAt ?? turn.startedAt;
		groups.push({
			anchor: `trace-turn-${turn.position}`,
			label: t("trace.turnSpan", { n: i + 1, elapsed: fmtElapsed(turn.startedAt, end) }),
			prompt: turn.prompt,
			ordinal: i + 1,
			turn,
			records,
		});
	}

	const flat = groups
		.flatMap((g) => g.records.map((r) => ({ ...r, anchor: g.anchor })))
		.sort((a, b) => a.at - b.at);
	return { groups, flat };
}

function syntheticPrompt(turn: TurnDTO): MessageDTO {
	return {
		position: -1,
		turnPosition: turn.position,
		role: "user",
		excerpt: turn.prompt,
		timestamp: turn.startedAt,
	};
}

function matchesQuery(r: TraceRecord, q: string): boolean {
	if (!q) return true;
	try {
		if (r.kind === "tool") {
			const tool = r.tool;
			const hay = `${tool.toolName} ${JSON.stringify(tool.input) ?? ""} ${tool.resultExcerpt ?? ""}`.toLowerCase();
			return hay.includes(q);
		}
		return (r.message.excerpt ?? "").toLowerCase().includes(q);
	} catch {
		return false;
	}
}

function TraceView({ session }: { session: SessionDetailDTO }) {
	const { t } = useI18n();
	const [mode, setMode] = useState<TraceViewMode>("turns");
	const [query, setQuery] = useState("");
	const [expandedTurns, setExpandedTurns] = useState<Set<string>>(() => new Set());

	const { groups, flat } = useMemo(
		() => buildGroups(session.turns, session.messages, session.toolCalls, t),
		[session.turns, session.messages, session.toolCalls, t],
	);

	const q = query.trim().toLowerCase();
	const shown = useMemo(() => flat.filter((r) => matchesQuery(r, q)), [flat, q]);
	const start = session.startedAt;
	const end = Math.max(session.lastActivityAt, ...flat.map((r) => r.at), 1);
	const toggleTurn = (anchor: string) => {
		setExpandedTurns((current) => {
			const next = new Set(current);
			if (next.has(anchor)) next.delete(anchor);
			else next.add(anchor);
			return next;
		});
	};

	return (
		<div className="trj">
			<div className="trj-toolbar">
				<div className="trj-modes" role="tablist" aria-label={t("detail.trace")}>
					<button
						type="button"
						role="tab"
						aria-selected={mode === "turns"}
						className={mode === "turns" ? "on" : ""}
						onClick={() => setMode("turns")}
					>
						{t("trace.viewTurns")}
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={mode === "calls"}
						className={mode === "calls" ? "on" : ""}
						onClick={() => setMode("calls")}
					>
						{t("trace.viewCalls")}
					</button>
				</div>
				{q && <span className="trj-count">{t("trace.matches", { shown: shown.length, total: flat.length })}</span>}
				<label className="trj-search">
					<svg viewBox="0 0 14 14" width="12" height="12" aria-hidden>
						<circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
						<line x1="9.4" y1="9.4" x2="12.6" y2="12.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
					</svg>
					<input
						type="search"
						placeholder={t("trace.search")}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
				</label>
			</div>

			{flat.length === 0 ? (
				<p className="muted trj-empty">{t("trace.noData")}</p>
			) : (
				<>
					<TimelineOverview groups={groups} start={start} end={end} />
					<div className="trj-tablewrap">
						<table className="trj-table">
							<thead>
								<tr>
									<th className="trj-col-event">{t("trace.event")}</th>
									<th>{t("th.title")}</th>
								</tr>
							</thead>
							{mode === "turns" ? (
								<tbody>
									{groups.map((g) => {
										const hit = g.records.filter((r) => matchesQuery(r, q));
										if (q && hit.length === 0) return null;
										const rows = q ? hit : g.records;
										const repeated = (g.turn?.steps ?? 1) > 1;
										const expanded = expandedTurns.has(g.anchor);
										const visibleRows = repeated && !expanded && !q ? rows.slice(0, 1) : rows;
										return visibleRows.map((r, i) => (
											<LedgerRow
												key={`${g.anchor}-${i}`}
												record={r}
												group={g}
												turnStart={i === 0}
												turnEnd={i === visibleRows.length - 1}
												repeated={repeated}
												expanded={expanded}
												onToggle={repeated ? () => toggleTurn(g.anchor) : undefined}
											/>
										));
									})}
								</tbody>
							) : (
								<tbody>
									{shown.map((r, i) => (
										<LedgerRow
											key={`flat-${i}`}
											record={r}
											group={null}
											turnStart={false}
											turnEnd={false}
											repeated={false}
											expanded={false}
										/>
									))}
								</tbody>
							)}
						</table>
						{mode === "calls" && q && shown.length === 0 && (
							<p className="muted trj-empty">{t("trace.noMatch")}</p>
						)}
					</div>
				</>
			)}
		</div>
	);
}

/**
 * Horizontal timing overview: one lane per record kind (assistant 0, tool 1,
 * user/context 2), spans projected left→right across the session domain.
 * Vertical rules mark turn boundaries; clicking a span scrolls to its row.
 */
function TimelineOverview({ groups, start, end }: { groups: Group[]; start: number; end: number }) {
	const { t } = useI18n();
	const span = Math.max(1, end - start);
	const pct = (at: number) => Math.min(100, Math.max(0, ((at - start) / span) * 100));
	const LANE: Record<TraceRecord["kind"], number> = { assistant: 0, tool: 1, user: 2, context: 2 };
	const DSH_LANE_PX = 14;
	const SPAN_H = 8;

	interface Span {
		key: string;
		kind: TraceRecord["kind"];
		error: boolean;
		left: number;
		width: number;
		anchor: string;
		title: string;
	}

	const spans: Span[] = [];
	for (const g of groups) {
		const nextGroupStart = groups[groups.indexOf(g) + 1]?.records[0]?.at;
		const groupEnd = g.turn?.endedAt ?? nextGroupStart ?? end;
		for (const [i, r] of g.records.entries()) {
			const tool = r.kind === "tool" ? r.tool : undefined;
			const nextAt = g.records[i + 1]?.at ?? groupEnd;
			const finish = tool?.durationMs != null ? r.at + tool.durationMs : nextAt;
			const width = Math.max(0.15, pct(finish) - pct(r.at));
			spans.push({
				key: `${g.anchor}-${i}`,
				kind: r.kind,
				error: tool?.isError === true,
				left: pct(r.at),
				width,
				anchor: g.anchor,
				title:
					tool != null
						? `${t("role.tool")} ${tool.toolName} · ${fmtClock(r.at)}${
								tool.durationMs != null ? ` · ${(tool.durationMs / 1000).toFixed(1)}s` : ""
							}`
						: `${t(`role.${r.kind}` as MsgKey)} · ${fmtClock(r.at)}`,
			});
		}
	}

	const turnStarts = groups.filter((g) => g.turn);

	return (
		<div className="trj-overview">
			<div className="trj-plot">
				<div className="trj-lanes" aria-hidden>
					<span>{t("role.assistant")}</span>
					<span>{t("role.tool")}</span>
					<span>{t("role.user")}</span>
				</div>
				<div className="trj-track">
					{turnStarts.map((g) => (
						<span
							key={`tb-${g.anchor}`}
							className="trj-turnline"
							style={{ left: `${pct(g.turn!.startedAt)}%` }}
						/>
					))}
					{spans.map((s) => (
						<a
							key={s.key}
							href={`#${s.anchor}`}
							className={`trj-span trj-span-${s.kind}${s.error ? " trj-span-error" : ""}`}
							style={{
								left: `${s.left}%`,
								width: `${s.width}%`,
								top: 7 + LANE[s.kind] * DSH_LANE_PX,
								height: SPAN_H,
							}}
							title={s.title}
						/>
					))}
				</div>
			</div>
			<div className="trj-legend">
				<div className="trj-timebar">
					<span>{fmtClock(start)}</span>
					<span>{fmtClock(start + span / 2)}</span>
					<span>{fmtClock(end)}</span>
				</div>
				{groups.map((g) => (
					<a key={g.anchor} href={`#${g.anchor}`} className="trj-legend-item">
						<span className="trj-legend-label">{g.label}</span>
						{g.prompt && <span className="trj-legend-prompt">{oneline(g.prompt)}</span>}
					</a>
				))}
			</div>
		</div>
	);
}

function LedgerRow({
	record,
	group,
	turnStart,
	turnEnd,
	repeated,
	expanded,
	onToggle,
}: {
	record: TraceRecord;
	group: Group | null;
	turnStart: boolean;
	turnEnd: boolean;
	repeated: boolean;
	expanded: boolean;
	onToggle?: () => void;
}) {
	const { t } = useI18n();
	const error = record.kind === "tool" && record.tool.isError;
	const kindLabel = t(`role.${record.kind}` as MsgKey);
	return (
		<tr
			id={turnStart && group ? group.anchor : undefined}
			data-kind={record.kind}
			data-turn={group ? group.anchor : undefined}
			data-error={error || undefined}
			data-turn-start={turnStart || undefined}
			data-turn-end={turnEnd || undefined}
			className={error ? "trj-row-error" : ""}
		>
			<td className="trj-event">
				{turnStart && group && (
					<div className="trj-turnhead">
						<span className={`trj-turnchip${group.turn?.state === "running" ? " trj-turnchip-running" : ""}`}>
							{group.turn ? t("trace.turn", { n: group.ordinal ?? group.turn.position }) : t("trace.systemInit")}
						</span>
						{repeated && onToggle && (
							<button
								type="button"
								className="trj-repeat"
								onClick={onToggle}
								aria-expanded={expanded}
							>
								{t("trace.steps", { n: group.turn?.steps ?? 1 })}
							</button>
						)}
					</div>
				)}
				<span className={`trj-kind trj-kind-${record.kind}`} title={`${kindLabel} · ${fmtClock(record.at)}`}>
					{kindLabel}
				</span>
			</td>
			<td className="trj-content">
				<details>
					<summary>
						<RecordSummary record={record} />
					</summary>
					<RecordDetail record={record} />
				</details>
			</td>
		</tr>
	);
}

function RecordSummary({ record }: { record: TraceRecord }) {
	const { t } = useI18n();
	if (record.kind === "tool") {
		const tool = record.tool;
		return (
			<span className="trj-resultgrid">
				<span className="trj-request">
					<span className="trj-toolname">{tool.toolName}</span>
					<span className="trj-payload">{onelineJson(tool.input)}</span>
				</span>
				<span className="trj-inline-result">
					<span className="trj-arrow">→</span>
					{tool.resultExcerpt ? (
						<span className="trj-result-text">{oneline(tool.resultExcerpt)}</span>
					) : (
						<span className="trj-nooutput">({t("trace.output")} —)</span>
					)}
				</span>
			</span>
		);
	}
	const m = record.message;
	const meta = [
		m.tokens != null ? `${fmtTokens(m.tokens)} tokens` : null,
		m.costUsd != null ? fmtCost(m.costUsd) : null,
	].filter(Boolean);
	return (
		<span className="trj-textgrid">
			<span className={`trj-text${record.syntheticPrompt ? " trj-prompt" : ""}`}>{oneline(m.excerpt ?? "")}</span>
			{meta.length > 0 && <span className="trj-meta">{meta.join(" · ")}</span>}
		</span>
	);
}

function RecordDetail({ record }: { record: TraceRecord }) {
	const { t } = useI18n();
	if (record.kind === "tool") {
		const tool = record.tool;
		return (
			<div className="trj-detail">
				<div className="trj-detail-head mono">
					{fmtClock(tool.startedAt)}
					{tool.durationMs != null && ` · ${(tool.durationMs / 1000).toFixed(1)}s`}
					{tool.isError && <span className="trj-error-flag">ERROR</span>}
				</div>
				<div className="trj-detail-label">{t("trace.input")}</div>
				<pre className="trj-detail-payload">{JSON.stringify(tool.input, null, 2)}</pre>
				{tool.resultExcerpt && (
					<>
						<div className="trj-detail-label">{t("trace.output")}</div>
						<pre className="trj-detail-payload">{tool.resultExcerpt}</pre>
					</>
				)}
			</div>
		);
	}
	return (
		<div className="trj-detail">
			<pre className="trj-detail-payload">{record.message.excerpt}</pre>
		</div>
	);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function checkbox(state: string): string {
	if (["done", "completed"].includes(state)) return "✓";
	return "";
}

function oneline(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function onelineJson(input: unknown): string {
	try {
		const raw = JSON.stringify(input) ?? "";
		return raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
	} catch {
		return String(input);
	}
}

function fmtTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtClock(ms: number): string {
	const d = new Date(ms);
	const p = (x: number) => String(x).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
