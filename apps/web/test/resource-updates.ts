import assert from "node:assert/strict";
import { createResourceUpdateChannel } from "../src/api.js";

class FakeEventSource {
	listeners = new Map<string, EventListener>();
	closed = false;

	addEventListener(type: string, listener: EventListener): void {
		this.listeners.set(type, listener);
	}

	close(): void {
		this.closed = true;
	}

	emitUpdate(): void {
		this.listeners.get("update")?.({} as Event);
	}
}

const sources: FakeEventSource[] = [];
const polling: Array<() => void> = [];
const intervalHandle = {} as ReturnType<typeof setInterval>;
let stopped = 0;
const updates = createResourceUpdateChannel(
	() => {
		const source = new FakeEventSource();
		sources.push(source);
		return source;
	},
	(listener) => {
		polling.push(listener);
		return intervalHandle;
	},
	(handle) => {
		assert.equal(handle, intervalHandle);
		stopped++;
	},
);

let first = 0;
let second = 0;
const unsubscribeFirst = updates.subscribe(() => { first++; });
const unsubscribeSecond = updates.subscribe(() => { second++; });
assert.equal(sources.length, 1, "mounted resources must share one SSE connection");
assert.equal(polling.length, 1, "mounted resources must share one polling fallback");

sources[0].emitUpdate();
assert.deepEqual([first, second], [1, 1], "SSE updates must refresh every subscriber");
polling[0]();
assert.deepEqual([first, second], [2, 2], "the polling fallback must refresh every subscriber");

unsubscribeFirst();
assert.equal(sources[0].closed, false, "the connection must remain open while subscribers remain");
unsubscribeSecond();
assert.equal(sources[0].closed, true, "the last unsubscribe must close the shared connection");
assert.equal(stopped, 1, "the last unsubscribe must stop the shared polling fallback");

const unsubscribeThird = updates.subscribe(() => {});
assert.equal(sources.length, 2, "a later subscriber must create a new connection");
unsubscribeSecond();
assert.equal(sources[1].closed, false, "a repeated cleanup must not close a newer connection");
unsubscribeThird();

console.log("resource update channel checks passed");
