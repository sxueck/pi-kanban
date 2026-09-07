import { useEffect, useRef, useState } from "react";
import type { InspectionLogDetailDTO, InspectionLogSummaryDTO, InspectionStageEvent } from "@pi-kanban/shared";
import { API_BASE, apiErrorMessage, fmtTime, getToken, useResource } from "../api.js";
import { useI18n } from "../i18n.js";
import type { MsgKey } from "../i18n.js";

/** Cap on the rendered transcript text: a full payload can reach ~400KB. */
const MAX_RENDER_CHARS = 200_000;

/** Live-streamed model text, updated token batch by token batch. */
export interface LiveText {
	reasoning: string;
	content: string;
}

export function appendLiveDelta(current: LiveText, delta: { type: "reasoning" | "content"; text: string }): LiveText {
	return { ...current, [delta.type]: current[delta.type] + delta.text };
}

interface RunEnvelope {
	running: boolean;
	inspectionId?: string;
	trigger?: "manual" | "schedule";
	startedAt?: number;
}

/**
 * Inspection log panel: history of retained transcripts (prompt / reasoning /
 * response) plus a live SSE stage timeline while a run is in flight.
 */
export function InspectionLogPanel({ projectId, onClose }: { projectId: number; onClose: () => void }) {
	const { t } = useI18n();
	const [refreshKey, setRefreshKey] = useState(0);
	const [selected, setSelected] = useState<string | null>(null);
	const [stages, setStages] = useState<InspectionStageEvent[]>([]);
	const [run, setRun] = useState<RunEnvelope | null>(null);
	const [liveText, setLiveText] = useState<LiveText>({ reasoning: "", content: "" });
	// Deltas accumulate here and flush to state on a 100ms cadence: a re-render
	// per token would thrash React at provider chunk rates.
	const pendingText = useRef<LiveText>({ reasoning: "", content: "" });
	const flushLiveText = () => {
		setLiveText((current) => {
			const next = pendingText.current;
			return next.reasoning === current.reasoning && next.content === current.content ? current : { ...next };
		});
	};
	const { data: logs } = useResource<InspectionLogSummaryDTO[]>(`/api/projects/${projectId}/inspection-logs`, refreshKey);
	const { data: detail, error: detailError } = useResource<InspectionLogDetailDTO>(
		selected ? `/api/projects/${projectId}/inspection-logs/${selected}` : null,
		refreshKey,
	);

	useEffect(() => {
		const source = new EventSource(
			`${API_BASE}/api/projects/${projectId}/inspection-log/stream?token=${encodeURIComponent(getToken())}`,
		);
		const onRun = (event: MessageEvent) => {
			const nextRun = parseSseJson<RunEnvelope>(event);
			if (!nextRun) return;
			setRun(nextRun);
			// Every (re)connect replays the full timeline after this envelope;
			// drop the previous connection's copy so nothing renders twice.
			pendingText.current = { reasoning: "", content: "" };
			setStages([]);
			setLiveText({ reasoning: "", content: "" });
		};
		const onSnapshot = (event: MessageEvent) => {
			const snapshot = parseSseJson<{ reasoning?: string; content?: string }>(event);
			if (!snapshot) return;
			pendingText.current = { reasoning: snapshot.reasoning ?? "", content: snapshot.content ?? "" };
			flushLiveText();
		};
		const onDelta = (event: MessageEvent) => {
			const delta = parseSseJson<{ type: "reasoning" | "content"; text: string }>(event);
			if (!delta) return;
			pendingText.current = appendLiveDelta(pendingText.current, delta);
		};
		const onStage = (event: MessageEvent) => {
			const stage = parseSseJson<InspectionStageEvent>(event);
			if (!stage) return;
			setStages((current) => [...current, stage]);
			if (stage.stage === "succeeded" || stage.stage === "failed") {
				// The persisted transcript commits before its finish stage is
				// recorded, so refreshing + selecting here is race-free; SSE ordering
				// guarantees every delta arrived before this event.
				setRefreshKey((key) => key + 1);
				setSelected(stage.inspectionId);
				pendingText.current = { reasoning: "", content: "" };
				setLiveText({ reasoning: "", content: "" });
			}
		};
		source.addEventListener("run", onRun as EventListener);
		source.addEventListener("stage", onStage as EventListener);
		source.addEventListener("snapshot", onSnapshot as EventListener);
		source.addEventListener("delta", onDelta as EventListener);
		return () => source.close();
	}, [projectId]);

	// Flush cadence for streamed tokens; independent of the SSE connection.
	useEffect(() => {
		const timer = setInterval(flushLiveText, 100);
		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		// Default to the newest run once the history loads.
		if (selected == null && logs != null && logs.length > 0) setSelected(logs[0].inspectionId);
	}, [logs, selected]);

	return (
		<div className="log-panel-overlay" onClick={onClose} role="presentation">
			<section className="log-panel" onClick={(event) => event.stopPropagation()} aria-label={t("logs.title")}>
				<header className="log-panel-head">
					<h2>{t("logs.title")}</h2>
					{run?.running && <span className="state state-running">{t("logs.liveRunning")}</span>}
					<button type="button" className="log-panel-close" onClick={onClose} aria-label={t("logs.close")}>
						✕
					</button>
				</header>
				<div className="log-panel-body">
					<aside className="log-runs">
						<LiveTimeline stages={stages} run={run} />
						{logs == null ? (
							<p className="muted">{t("common.loading")}</p>
						) : logs.length === 0 ? (
							<p className="muted">{t("logs.empty")}</p>
						) : (
							<ul>
								{logs.map((log) => (
									<li key={log.inspectionId}>
										<button
											type="button"
											className={selected === log.inspectionId ? "is-selected" : ""}
											onClick={() => setSelected(log.inspectionId)}
										>
											<span className={`status-${log.status}`}>{t(`logs.trigger.${log.trigger}` as MsgKey)}</span>
											<span>{fmtTime(log.startedAt)}</span>
											<span className={`state status-${log.status === "done" ? "finished" : log.status === "failed" ? "error" : "running"}`}>
												{t(`logs.status.${log.status}` as MsgKey)}
											</span>
										</button>
									</li>
								))}
							</ul>
						)}
					</aside>
					<main className="log-detail">
						<LiveStreamBlocks liveText={liveText} />
						{detail == null ? (
							<p className="muted">{detailError ? apiErrorMessage(detailError) : selected ? t("common.loading") : t("logs.select")}</p>
						) : (
							<>
								<div className="card-meta">
									<span>{t("logs.runAt", { time: fmtTime(detail.inspection.startedAt) })}</span>
									<span>{t("logs.redactions", { n: detail.inspection.redactionCount })}</span>
									{detail.inspection.error && <span className="error-flag">{detail.inspection.error}</span>}
								</div>
								<LogSection title={t("logs.system")} text={detail.systemPrompt} />
								{detail.requestPayload != null && <LogSection title={t("logs.payload")} text={pretty(detail.requestPayload)} />}
								{detail.reasoningContent != null && <LogSection title={t("logs.reasoning")} text={detail.reasoningContent} />}
								{detail.responseContent != null && <LogSection title={t("logs.response")} text={prettyText(detail.responseContent)} />}
							</>
						)}
					</main>
				</div>
			</section>
		</div>
	);
}

/** Live-streamed model text blocks: reasoning and output as they arrive. */
export function LiveStreamBlocks({ liveText }: { liveText: LiveText }) {
	const { t } = useI18n();
	if (!liveText.reasoning && !liveText.content) return null;
	return (
		<div className="log-live-stream">
			{liveText.reasoning && <LiveBlock title={t("logs.liveReasoning")} text={liveText.reasoning} />}
			{liveText.content && <LiveBlock title={t("logs.liveOutput")} text={liveText.content} />}
		</div>
	);
}

function LiveBlock({ title, text }: { title: string; text: string }) {
	const preRef = useRef<HTMLPreElement | null>(null);
	// Stay pinned to the tail only while the user has not scrolled away.
	const stick = useRef(true);
	useEffect(() => {
		const el = preRef.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	}, [text]);
	return (
		<section className="log-section log-live-block">
			<h3>
				<span className="live-dot" aria-hidden="true" />
				{title}
			</h3>
			<pre
				ref={preRef}
				onScroll={(event) => {
					const el = event.currentTarget;
					stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
				}}
			>
				{text}
			</pre>
		</section>
	);
}

function LogSection({ title, text }: { title: string; text: string }) {
	const { t } = useI18n();
	const truncated = text.length > MAX_RENDER_CHARS;
	return (
		<details className="log-section" open>
			<summary>
				{title}
				<span className="muted">{truncated ? t("logs.truncated") : `${text.length} chars`}</span>
			</summary>
			<pre>{truncated ? `${text.slice(0, MAX_RENDER_CHARS)}\n…` : text}</pre>
		</details>
	);
}

function LiveTimeline({ stages, run }: { stages: InspectionStageEvent[]; run: RunEnvelope | null }) {
	const { t } = useI18n();
	if (stages.length === 0 && !(run?.running)) return null;
	return (
		<div className="log-live">
			<h3>{t("logs.live")}</h3>
			{stages.length === 0 ? (
				<p className="muted">{t("logs.liveWaiting")}</p>
			) : (
				<ol className="stage-timeline">
					{stages.map((stage, index) => (
						<li key={index} className={`stage-${stage.stage}`}>
							<span className="stage-icon" aria-hidden="true" />
							<span className="stage-text">{describeStage(stage, t)}</span>
						</li>
					))}
				</ol>
			)}
		</div>
	);
}

function describeStage(stage: InspectionStageEvent, t: (key: MsgKey, params?: Record<string, string | number>) => string): string {
	switch (stage.stage) {
		case "assembled":
			return t("logs.stage.assembled", {
				kb: Math.max(1, Math.round(stage.bytes / 1024)),
				n: stage.redactions,
			});
		case "request_sent":
			return t("logs.stage.request_sent", { model: stage.model, s: Math.round(stage.timeoutMs / 1000) });
		case "tool_completed":
			return t("logs.stage.tool_completed", {
				round: stage.round,
				tool: stage.tool,
				status: stage.status,
				kb: Math.max(1, Math.round(stage.resultBytes / 1024)),
				n: stage.redactions,
			});
		case "succeeded":
			return t("logs.stage.succeeded", { m: stage.memories, k: stage.treeNodes, s: Math.round(stage.elapsedMs / 1000) });
		case "failed":
			return t("logs.stage.failed", { s: Math.round(stage.elapsedMs / 1000), error: stage.error.slice(0, 200) });
	}
}

function parseSseJson<T>(event: MessageEvent): T | null {
	try {
		return JSON.parse(String(event.data)) as T;
	} catch {
		return null;
	}
}

function pretty(value: unknown): string {
	try {
		return cap(JSON.stringify(value, null, 2) ?? "");
	} catch {
		return cap(String(value));
	}
}

function prettyText(value: string | undefined): string {
	if (value == null) return "";
	try {
		return cap(JSON.stringify(JSON.parse(value), null, 2));
	} catch {
		return cap(value);
	}
}

function cap(text: string): string {
	return text.length > MAX_RENDER_CHARS ? `${text.slice(0, MAX_RENDER_CHARS)}\n…` : text;
}
