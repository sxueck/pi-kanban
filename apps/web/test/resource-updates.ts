import assert from "node:assert/strict";
import { createResourceLoader, createResourceUpdateChannel } from "../src/api.js";

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
sources[0].emitUpdate();
sources[0].emitUpdate();
assert.deepEqual([first, second], [1, 1], "updates inside the burst window must coalesce into the pending catch-up");
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const lastSource = () => sources[sources.length - 1];

// trailing catch-up fires after the burst window; closing the shared connection cancels it
let fastCount = 0;
const fastChannel = createResourceUpdateChannel(
	() => {
		const source = new FakeEventSource();
		sources.push(source);
		return source;
	},
	(listener) => {
		polling.push(listener);
		return intervalHandle;
	},
	undefined,
	20,
);
const unsubscribeFast = fastChannel.subscribe(() => { fastCount++; });
lastSource().emitUpdate();
assert.equal(fastCount, 1, "the first update notifies immediately");
lastSource().emitUpdate();
assert.equal(fastCount, 1, "an update right after the first must wait for the catch-up");
await sleep(60);
assert.equal(fastCount, 2, "the trailing catch-up notifies once after the burst window");
lastSource().emitUpdate();
lastSource().emitUpdate();
const afterClose = fastCount;
unsubscribeFast();
await sleep(60);
assert.equal(fastCount, afterClose, "closing the shared connection must cancel the pending catch-up");

// --- createResourceLoader ------------------------------------------------------

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeLoader() {
	const events: string[] = [];
	const fetches: Array<Deferred<string>> = [];
	const loader = createResourceLoader<string>(
		(path) => {
			events.push(`fetch:${path}`);
			const pending = deferred<string>();
			fetches.push(pending);
			return pending.promise;
		},
		{
			data: (value) => events.push(`data:${value}`),
			error: (err) => events.push(`error:${err ? err.message : "null"}`),
			loading: (busy) => events.push(`loading:${busy}`),
		},
	);
	const flush = async () => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	};
	return { events, fetches, loader, flush };
}

// an update storm while the first fetch is in flight must not cancel it nor
// stack requests: results land and exactly one catch-up refetch follows
{
	const { events, fetches, loader, flush } = makeLoader();
	loader.request("/api/board");
	loader.request("/api/board");
	loader.request("/api/board");
	assert.deepEqual(events, ["loading:true", "fetch:/api/board"], "mid-flight refreshes must not start new fetches");
	fetches[0].resolve("v1");
	await flush();
	assert.ok(events.includes("data:v1"), "the in-flight result must land despite later refreshes");
	assert.ok(!events.includes("error"), "a landed result must clear the error");
	assert.deepEqual(
		events.filter((e) => e === "loading:true"),
		["loading:true"],
		"a refresh with data on screen must not re-enter loading",
	);
	assert.equal(events.filter((e) => e.startsWith("fetch:")).length, 2, "the storm collapses into one catch-up fetch");
	fetches[1].resolve("v2");
	await flush();
	assert.ok(events.includes("data:v2"));
}

// a settled refresh keeps stale data visible (no loading flip, no data reset)
{
	const { events, fetches, loader, flush } = makeLoader();
	loader.request("/api/sessions");
	fetches[0].resolve("first");
	await flush();
	events.length = 0;
	loader.request("/api/sessions");
	assert.deepEqual(
		events.filter((e) => e === "loading:true" || e === "data:null"),
		[],
		"a background refresh must keep the current data and stay out of loading",
	);
	fetches[1].resolve("second");
	await flush();
	assert.ok(events.includes("data:second"));
}

// a path change discards the previous path's late result and resets loading
{
	const { events, fetches, loader, flush } = makeLoader();
	loader.request("/api/projects/1/work");
	loader.request("/api/projects/4/work");
	assert.equal(events.filter((e) => e.startsWith("fetch:")).length, 2, "a path change must fetch the new path at once");
	fetches[0].resolve("stale-from-1");
	await flush();
	assert.ok(!events.includes("data:stale-from-1"), "the old path's late result must not land");
	assert.ok(events.includes("loading:true"), "the new path must load through the initial loading state");
	fetches[1].resolve("fresh-from-4");
	await flush();
	assert.ok(events.includes("data:fresh-from-4"));
}

// errors surface and clear on the next successful refresh
{
	const { events, fetches, loader, flush } = makeLoader();
	loader.request("/api/stats/total");
	fetches[0].reject(new Error("boom"));
	await flush();
	assert.ok(events.includes("error:boom"));
	loader.request("/api/stats/total");
	assert.ok(events.includes("loading:true"), "a retry with no data yet must show loading again");
	fetches[1].resolve("ok");
	await flush();
	assert.ok(events.includes("error:null") && events.includes("data:ok"));
}

// dispose drops late results silently
{
	const { events, fetches, loader, flush } = makeLoader();
	loader.request("/api/board");
	loader.dispose();
	events.length = 0;
	fetches[0].resolve("late");
	await flush();
	assert.deepEqual(events, [], "a disposed loader must not notify");
	loader.request("/api/board");
	assert.deepEqual(events, [], "a disposed loader must reject further requests");
}

console.log("resource update channel checks passed");
