import { EventEmitter } from "node:events";
import type {
	InspectionDelta,
	InspectionDeltaEvent,
	InspectionStageEvent,
	InspectionSnapshotEvent,
} from "@pi-kanban/shared";

/**
 * In-memory live timeline of the newest inspection run per project. Stage and
 * delta events are recorded by the inspector and replayed to SSE subscribers,
 * so a browser attached mid-run (or right after it finished) still sees the
 * whole timeline plus the text streamed so far. Single-process server, same
 * lifetime contract as bus.ts; after a restart the map is simply empty until
 * the next run.
 *
 * Wire-event discrimination: stage events carry `.stage`, delta events carry
 * `.type` ("reasoning" | "content") and `.text`, snapshots carry neither.
 */
export type InspectionLiveEvent = InspectionStageEvent | InspectionDeltaEvent | InspectionSnapshotEvent;

/** Mirrors the model client's character cap; buffering stops (streaming continues) past it. */
const MAX_BUFFERED_CHARS = 400_000;

interface LiveRun {
	inspectionId: string;
	trigger: "manual" | "schedule";
	startedAt: number;
	running: boolean;
	stages: InspectionStageEvent[];
	reasoningText: string;
	contentText: string;
}

const runs = new Map<number, LiveRun>();
const emitter = new EventEmitter();

export interface LiveInspectionSnapshot {
	inspectionId: string;
	trigger: "manual" | "schedule";
	startedAt: number;
	running: boolean;
	stages: InspectionStageEvent[];
	reasoningText: string;
	contentText: string;
}

export function recordInspectionStage(
	projectId: number,
	trigger: "manual" | "schedule",
	stage: InspectionStageEvent,
): void {
	const current = runs.get(projectId);
	// A stage from a different inspectionId (a newer claim took over) starts a
	// fresh timeline instead of interleaving two runs.
	const run = current && current.inspectionId === stage.inspectionId
		? current
		: { inspectionId: stage.inspectionId, trigger, startedAt: Date.now(), running: true, stages: [], reasoningText: "", contentText: "" };
	if (run.stages.length === 0) run.startedAt = Date.now();
	run.stages.push(stage);
	if (stage.stage === "succeeded" || stage.stage === "failed") run.running = false;
	runs.set(projectId, run);
	emitter.emit(`project:${projectId}`, stage);
}

export function recordInspectionDelta(projectId: number, inspectionId: string, delta: InspectionDelta): void {
	const run = runs.get(projectId);
	// Deltas for a run other than the current one (a late chunk racing a newer
	// claim) are dropped: they belong to a run that is no longer being shown.
	if (!run || run.inspectionId !== inspectionId) return;
	if (delta.type === "reasoning") {
		if (run.reasoningText.length < MAX_BUFFERED_CHARS) run.reasoningText += delta.text;
	} else if (run.contentText.length < MAX_BUFFERED_CHARS) {
		run.contentText += delta.text;
	}
	const event: InspectionDeltaEvent = { inspectionId, ...delta };
	emitter.emit(`project:${projectId}`, event);
}

export function getLiveInspection(projectId: number): LiveInspectionSnapshot | null {
	const run = runs.get(projectId);
	if (!run) return null;
	return { ...run, stages: [...run.stages] };
}

/**
 * Replays the current timeline (stages, then a snapshot of the text buffered
 * so far when any), then follows live stage/delta events; returns an
 * unsubscribe. Replay happens synchronously before this call returns.
 */
export function subscribeInspectionLive(
	projectId: number,
	listener: (event: InspectionLiveEvent) => void,
): () => void {
	const channel = `project:${projectId}`;
	const run = runs.get(projectId);
	if (run) {
		for (const stage of run.stages) listener(stage);
		if (run.reasoningText || run.contentText) {
			const snapshot: InspectionSnapshotEvent = {
				inspectionId: run.inspectionId,
				...(run.reasoningText ? { reasoning: run.reasoningText } : {}),
				...(run.contentText ? { content: run.contentText } : {}),
			};
			listener(snapshot);
		}
	}
	emitter.on(channel, listener);
	return () => {
		emitter.off(channel, listener);
	};
}
