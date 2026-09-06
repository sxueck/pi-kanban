import { useCallback, useEffect, useRef, useState } from "react";

export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
export const UNAUTHORIZED_EVENT = "pi-kanban:unauthorized";

export function getToken(): string {
	return localStorage.getItem("pikanban_token") ?? "";
}

export function setToken(token: string): void {
	localStorage.setItem("pikanban_token", token);
}

export function clearToken(): void {
	localStorage.removeItem("pikanban_token");
}

export async function apiGetPublic<T>(path: string): Promise<T> {
	const res = await fetch(`${API_BASE}${path}`);
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
	return (await res.json()) as T;
}

export async function apiPostPublic<T>(path: string, body: unknown, headers?: HeadersInit): Promise<T> {
	const res = await fetch(`${API_BASE}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
	return (await res.json()) as T;
}

export async function apiGet<T>(path: string): Promise<T> {
	const res = await fetch(`${API_BASE}${path}`, {
		headers: { authorization: `Bearer ${getToken()}` },
	});
	if (res.status === 401) throwUnauthorized();
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
	return (await res.json()) as T;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch(`${API_BASE}${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${getToken()}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (res.status === 401) throwUnauthorized();
	if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
	return (await res.json()) as T;
}

export async function apiDelete(path: string): Promise<void> {
	const res = await fetch(`${API_BASE}${path}`, {
		method: "DELETE",
		headers: { authorization: `Bearer ${getToken()}` },
	});
	if (res.status === 401) throwUnauthorized();
	if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
}

/**
 * Extract a friendly message from an apiGet/apiPost error. Non-2xx responses
 * throw `${status} ${body}` where body is usually `{"error": "..."}` JSON.
 */
export function apiErrorMessage(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	const text = err.message.replace(/^\d+\s+/, "");
	try {
		const parsed = JSON.parse(text) as { error?: unknown };
		if (typeof parsed.error === "string") return parsed.error;
	} catch {
		// not JSON — fall back to the raw message
	}
	return err.message;
}

function throwUnauthorized(): never {
	window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
	throw new UnauthorizedError();
}

export class UnauthorizedError extends Error {
	constructor() {
		super("unauthorized");
	}
}

type RefreshListener = () => void;

interface EventSourceLike {
	addEventListener(type: string, listener: EventListener): void;
	close(): void;
}

type IntervalHandle = ReturnType<typeof setInterval>;

export function createResourceUpdateChannel(
	openEventSource: () => EventSourceLike,
	startPolling: (listener: RefreshListener) => IntervalHandle = (listener) => setInterval(listener, 15_000),
	stopPolling: (handle: IntervalHandle) => void = clearInterval,
): { subscribe(listener: RefreshListener): () => void } {
	const listeners = new Set<RefreshListener>();
	let source: EventSourceLike | undefined;
	let polling: IntervalHandle | undefined;
	const refresh = () => {
		for (const listener of listeners) listener();
	};

	return {
		subscribe(listener) {
			const subscription = () => listener();
			listeners.add(subscription);
			if (listeners.size === 1) {
				source = openEventSource();
				source.addEventListener("update", refresh as EventListener);
				polling = startPolling(refresh);
			}
			return () => {
				if (!listeners.delete(subscription) || listeners.size !== 0) return;
				source?.close();
				source = undefined;
				if (polling !== undefined) stopPolling(polling);
				polling = undefined;
			};
		},
	};
}

const resourceUpdates = createResourceUpdateChannel(
	() => new EventSource(`${API_BASE}/api/events?token=${encodeURIComponent(getToken())}`),
);

/**
 * Fetch a resource, refresh it on shared SSE updates and a slow polling fallback.
 * Re-fetches whenever `refreshKey` changes (used after mutations).
 */
export function useResource<T>(path: string | null, refreshKey = 0): {
	data: T | null;
	error: Error | null;
	loading: boolean;
} {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<Error | null>(null);
	const [loading, setLoading] = useState(true);
	const [version, setVersion] = useState(0);
	const alive = useRef(true);

	const refetch = useCallback(() => setVersion((v) => v + 1), []);

	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	useEffect(() => {
		if (!path) return;
		let cancelled = false;
		setLoading(true);
		apiGet<T>(path)
			.then((result) => {
				if (!cancelled && alive.current) {
					setData(result);
					setError(null);
				}
			})
			.catch((err: unknown) => {
				if (!cancelled && alive.current) setError(err as Error);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [path, version, refreshKey]);

	// One app-wide stream refreshes all mounted resources without consuming one
	// long-lived HTTP connection per resource.
	useEffect(() => {
		if (!path) return;
		return resourceUpdates.subscribe(refetch);
	}, [path, refetch]);

	return { data, error, loading };
}

// --- formatting helpers ---------------------------------------------------------

/** cacheRead / (fresh input + cacheRead); undefined until the plugin reports usage. */
export function cacheHitRate(s: { cacheReadTokens?: number; inputTokens?: number }): number | undefined {
	const cacheRead = s.cacheReadTokens ?? 0;
	const input = s.inputTokens ?? 0;
	if (cacheRead + input <= 0) return undefined;
	return cacheRead / (cacheRead + input);
}

export function fmtCost(usd: number): string {
	return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
}

export function fmtElapsed(fromMs: number, toMs?: number): string {
	const ms = (toMs ?? Date.now()) - fromMs;
	const sec = Math.max(0, Math.floor(ms / 1000));
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m${sec % 60}s`;
	const hr = Math.floor(min / 60);
	return `${hr}h${min % 60}m`;
}

export function fmtTime(ms: number): string {
	return new Date(ms).toLocaleString();
}
