import { randomUUID } from "node:crypto";
import type {
	ApprovalRequestMessage,
	DownstreamMessage,
	HelloMessage,
	UpstreamMessage,
} from "@pi-kanban/shared";
import { PROTOCOL_VERSION } from "@pi-kanban/shared";
import { machineId, PLUGIN_VERSION } from "./config.js";

const OUTBOX_CAP = 500;
const CREATED_ACK_TIMEOUT_MS = 5_000;
/** Connected but no inbound traffic for this long = black hole (sleep, NAT
 * change); force a reconnect instead of waiting minutes for a TCP timeout. */
const STALE_AFTER_MS = 90_000;
const HTTP_HEARTBEAT_TIMEOUT_MS = 5_000;

/** Cloud decision, or "offline" when the connection dropped before one arrived. */
export type DecisionVerdict = "approved" | "denied" | "offline";

type DecisionListener = (verdict: DecisionVerdict) => void;

/**
 * Resilient WebSocket client on Node's native WebSocket (Node >= 22).
 * - Fire-and-forget upstream messages queue in an outbox while disconnected.
 * - Approval flows get request/ack semantics: requestApproval() resolves with
 *   the server-assigned approvalId, waitForDecision() with the verdict.
 * - On disconnect, pending decision waiters are released with "offline"
 *   (the gate treats that as "plugin absent": allow).
 */
export class Transport {
	private ws: WebSocket | null = null;
	private outbox: string[] = [];
	private manuallyClosed = false;
	private reconnectMs = 1_000;
	private lastInboundAt = 0;
	private readonly heartbeatUrl: string;
	private decisionListeners = new Map<string, Set<DecisionListener>>();
	private createdWaiters = new Map<string, (approvalId: string) => void>();

	constructor(
		private readonly url: string,
		private readonly agentToken: string,
	) {
		// ws(s)://host:port/agent -> http(s)://host:port/agent/heartbeat
		try {
			const httpUrl = new URL(url.replace(/^ws(s?):/, "http$1:"));
			httpUrl.pathname = `${httpUrl.pathname.replace(/\/$/, "")}/heartbeat`;
			// Outbound URLs must be plain HTTP(S) — guards a misconfigured server URL.
			this.heartbeatUrl = httpUrl.protocol === "http:" || httpUrl.protocol === "https:" ? httpUrl.toString() : "";
		} catch {
			this.heartbeatUrl = "";
		}
	}

	connect(): void {
		if (this.manuallyClosed || this.ws) return;
		let ws: WebSocket;
		try {
			ws = new WebSocket(this.url);
		} catch {
			this.scheduleReconnect();
			return;
		}
		this.ws = ws;
		ws.onopen = () => {
			this.reconnectMs = 1_000;
			this.lastInboundAt = Date.now();
			this.rawSend(this.hello());
			while (this.outbox.length > 0) {
				this.rawSend(this.outbox.shift()!);
			}
		};
		ws.onmessage = (ev: MessageEvent) => this.onDownstream(String(ev.data));
		// Node 22 can omit `close` after refused connections; using one idempotent
		// path also avoids recursively closing from `onerror`.
		ws.onclose = () => this.handleClose(ws);
		ws.onerror = () => this.handleClose(ws);
	}

	close(): void {
		this.manuallyClosed = true;
		const ws = this.ws;
		ws?.close();
		if (ws) this.handleClose(ws);
	}

	get connected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	send(msg: UpstreamMessage): void {
		const raw = JSON.stringify(msg);
		if (this.connected) this.rawSend(raw);
		else if (this.outbox.length < OUTBOX_CAP) this.outbox.push(raw);
	}

	/**
	 * Liveness tick, called every 30s:
	 * - WS heartbeat while connected (the server's heartbeat_ack doubles as the
	 *   downstream signal feeding the staleness watchdog below);
	 * - watchdog: connected but no inbound traffic for STALE_AFTER_MS -> the
	 *   socket is a black hole (heartbeats vanish server-side, sessions show
	 *   offline) — close it now so the normal reconnect path takes over;
	 * - HTTP heartbeat unconditionally — a stateless request immune to WS
	 *   flakiness, so sessions stay alive on the board even while reconnecting.
	 */
	heartbeat(sessionIds: string[]): void {
		const now = Date.now();
		if (this.connected) {
			if (this.lastInboundAt && now - this.lastInboundAt > STALE_AFTER_MS) {
				console.error("[pi-kanban] connection stale (no server traffic); reconnecting");
				this.ws?.close();
				return;
			}
			this.send({ type: "heartbeat", sessionIds, timestamp: now });
		}
		void this.httpHeartbeat(sessionIds);
	}

	private async httpHeartbeat(sessionIds: string[]): Promise<void> {
		if (!this.heartbeatUrl || !this.agentToken) return;
		try {
			// Client-side plugin dialing its own operator-configured server (same
			// trust boundary as the WS URL); constructor already pins http(s).
			// pi-lens-ignore: ts-ssrf
			const res = await fetch(this.heartbeatUrl, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.agentToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ machineId: machineId(), sessionIds }),
				signal: AbortSignal.timeout(HTTP_HEARTBEAT_TIMEOUT_MS),
			});
			if (!res.ok) console.error(`[pi-kanban] http heartbeat failed: HTTP ${res.status}`);
		} catch {
			// Server unreachable — the sweep marks sessions offline; reconnect keeps trying.
		}
	}

	async requestApproval(
		msg: Omit<ApprovalRequestMessage, "requestId">,
		timeoutMs = CREATED_ACK_TIMEOUT_MS,
	): Promise<string | null> {
		const requestId = randomUUID();
		return new Promise((resolve) => {
			const finish = (approvalId: string | null) => {
				clearTimeout(timer);
				this.createdWaiters.delete(requestId);
				resolve(approvalId);
			};
			const timer = setTimeout(() => finish(null), timeoutMs);
			this.createdWaiters.set(requestId, (approvalId) => finish(approvalId || null));
			this.send({ ...msg, requestId });
		});
	}

	waitForDecision(approvalId: string, onDecision: DecisionListener): () => void {
		const set = this.decisionListeners.get(approvalId) ?? new Set<DecisionListener>();
		set.add(onDecision);
		this.decisionListeners.set(approvalId, set);
		return () => {
			set.delete(onDecision);
			if (set.size === 0) this.decisionListeners.delete(approvalId);
		};
	}

	private handleClose(ws: WebSocket): void {
		if (this.ws !== ws) return;
		this.ws = null;
		this.failWaiters();
		this.releaseDecisionWaitersOffline();
		this.scheduleReconnect();
	}

	private hello(): string {
		const hello: HelloMessage = {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			pluginVersion: PLUGIN_VERSION,
			machineId: machineId(),
			agentToken: this.agentToken,
		};
		return JSON.stringify(hello);
	}

	private onDownstream(raw: string): void {
		this.lastInboundAt = Date.now();
		let msg: DownstreamMessage;
		try {
			msg = JSON.parse(raw) as DownstreamMessage;
		} catch {
			return;
		}
		if (msg.type === "approval_created") {
			this.createdWaiters.get(msg.requestId)?.(msg.approvalId);
		} else if (msg.type === "approval_decision") {
			const set = this.decisionListeners.get(msg.approvalId);
			if (set) for (const listener of set) listener(msg.decision);
		}
	}

	private failWaiters(): void {
		for (const waiter of this.createdWaiters.values()) waiter("");
		this.createdWaiters.clear();
	}

	private releaseDecisionWaitersOffline(): void {
		for (const set of [...this.decisionListeners.values()]) {
			for (const listener of set) listener("offline");
		}
		this.decisionListeners.clear();
	}

	private scheduleReconnect(): void {
		if (this.manuallyClosed) return;
		setTimeout(() => this.connect(), this.reconnectMs).unref?.();
		// Cap low: the approval channel is down until we are back, and the HTTP
		// heartbeat already covers board liveness in the meantime.
		this.reconnectMs = Math.min(this.reconnectMs * 2, 10_000);
	}

	private rawSend(raw: string): void {
		try {
			this.ws?.send(raw);
		} catch {
			// socket died mid-send; onclose will reschedule
		}
	}
}
