import { EventEmitter } from "node:events";

export type BusEvent =
	| { type: "session_update"; sessionId: string }
	| { type: "approval_update"; approvalId: string; sessionId: string }
	| { type: "project_update"; userId: string; projectId: number };

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

export function publish(event: BusEvent): void {
	emitter.emit("event", event);
}

export function subscribe(listener: (event: BusEvent) => void): () => void {
	emitter.on("event", listener);
	return () => emitter.off("event", listener);
}
