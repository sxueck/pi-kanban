import { WebSocketServer, type WebSocket } from "ws";
import type { DownstreamMessage, HelloAckMessage, UpstreamMessage } from "@pi-kanban/shared";
import { PROTOCOL_VERSION } from "@pi-kanban/shared";
import { handleUpstream } from "./ingest.js";
import { authenticateAgentToken } from "./auth.js";

export interface AgentConnection {
	ws: WebSocket;
	machineId: string;
	machineName?: string;
	userId: string;
	authenticated: boolean;
	/** Set false before each ping; a pong flips it back. False twice = dead socket. */
	isAlive: boolean;
	/** Serializes upstream handling per connection: upstream messages are ordered
	 * (session_start must land before turn_start) and handlers are async. */
	queue: Promise<void>;
}

// userId:machineId -> live connections. Every pi session on a machine holds
// its own socket; approval decisions must reach the session that opened the
// approval, so delivery broadcasts to all of them (plugins ignore decisions
// for approvalIds they never requested).
const connections = new Map<string, Set<AgentConnection>>();
const sockets = new WeakMap<WebSocket, AgentConnection>();

export const agentWss = new WebSocketServer({ noServer: true });

/** Registers an authenticated connection under its machine. */
export function registerConnection(conn: AgentConnection): void {
	if (!conn.userId || !conn.machineId) return;
	const key = connectionKey(conn.userId, conn.machineId);
	let set = connections.get(key);
	if (!set) {
		set = new Set();
		connections.set(key, set);
	}
	set.add(conn);
}

/** Drops a closed connection; the machine's other connections keep receiving. */
export function unregisterConnection(conn: AgentConnection): void {
	if (!conn.userId || !conn.machineId) return;
	const key = connectionKey(conn.userId, conn.machineId);
	const set = connections.get(key);
	if (!set) return;
	set.delete(conn);
	if (set.size === 0) connections.delete(key);
}

const HELLO_TIMEOUT_MS = 10_000;

export function handleUpgrade(ws: WebSocket): void {
	const conn: AgentConnection = {
		ws,
		machineId: "",
		userId: "",
		authenticated: false,
		isAlive: true,
		queue: Promise.resolve(),
	};
	sockets.set(ws, conn);

	const helloTimer = setTimeout(() => {
		if (!conn.authenticated) ws.close(4001, "hello timeout");
	}, HELLO_TIMEOUT_MS);

	ws.on("pong", () => {
		conn.isAlive = true;
	});

	ws.on("message", (data) => {
		const raw = data.toString();
		conn.queue = conn.queue
			.then(() => onMessage(conn, raw))
			.catch((error) => console.error("[ws] message handler crashed:", error));
	});
	ws.on("close", () => {
		clearTimeout(helloTimer);
		unregisterConnection(conn);
	});
	ws.on("error", () => ws.close());
}

async function onMessage(conn: AgentConnection, raw: string): Promise<void> {
	let msg: UpstreamMessage;
	try {
		msg = JSON.parse(raw) as UpstreamMessage;
	} catch {
		send(conn.ws, { type: "error", message: "invalid JSON" });
		return;
	}

	if (!conn.authenticated) {
		if (msg.type !== "hello") {
			conn.ws.close(4003, "expected hello first");
			return;
		}
		const ack = await authenticate(conn, msg);
		send(conn.ws, ack);
		if (!ack.ok) {
			conn.ws.close(4003, "unauthorized");
		}
		return;
	}

	if (msg.type === "hello") {
		send(conn.ws, { type: "error", message: "already authenticated" });
		return;
	}

	try {
		const replies = await handleUpstream(msg, conn);
		for (const reply of replies) send(conn.ws, reply);
	} catch (error) {
		reportIngestError(conn, msg, error);
	}
}

async function authenticate(
	conn: AgentConnection,
	hello: Extract<UpstreamMessage, { type: "hello" }>,
): Promise<HelloAckMessage> {
	const agent = await authenticateAgentToken(hello.agentToken);
	if (!agent) {
		return { type: "hello_ack", ok: false, error: "invalid agent token", serverTime: Date.now() };
	}
	if (hello.protocolVersion !== PROTOCOL_VERSION) {
		return {
			type: "hello_ack",
			ok: false,
			error: `protocol version mismatch (server ${PROTOCOL_VERSION}, plugin ${hello.protocolVersion})`,
			serverTime: Date.now(),
		};
	}
	conn.machineId = hello.machineId;
	conn.machineName = hello.machineName;
	conn.userId = agent.userId;
	conn.authenticated = true;
	registerConnection(conn);
	return { type: "hello_ack", ok: true, serverTime: Date.now() };
}

function reportIngestError(conn: AgentConnection, msg: UpstreamMessage, error: unknown): void {
	const detail = error instanceof Error ? error.message : String(error);
	// drizzle wraps the driver error in `cause`; surface the whole chain.
	const causes: string[] = [];
	for (let cause = (error as { cause?: unknown })?.cause; cause; cause = (cause as { cause?: unknown })?.cause) {
		causes.push(cause instanceof Error ? cause.message : String(cause));
	}
	console.error(
		`[ws] ingest error machine=${conn.machineId} msg=${msg.type}: ${detail}` +
			(causes.length > 0 ? ` | cause: ${causes.join(" | cause: ")}` : ""),
	);
	// Ingest failures must never wedge the plugin: swallow after logging,
	// except approval requests which the plugin needs an ack for.
	send(conn.ws, { type: "error", message: `ingest failed for ${msg.type}` });
}

/** Best-effort downstream push; returns true when at least one socket took it. */
export function sendToMachine(
	userId: string,
	machineId: string,
	msg: DownstreamMessage,
): boolean {
	const set = connections.get(connectionKey(userId, machineId));
	if (!set) return false;
	let delivered = false;
	for (const conn of set) {
		if (conn.ws.readyState !== conn.ws.OPEN) continue;
		send(conn.ws, msg);
		delivered = true;
	}
	return delivered;
}

function connectionKey(userId: string, machineId: string): string {
	return `${userId}:${machineId}`;
}

// Server-initiated ping/pong: undici-based clients auto-pong, so any pinged
// connection answers within an interval. Sockets gone silent (sleep, NAT
// teardown, half-open TCP) are terminated within ~2 intervals instead of
// lingering in the map until a TCP timeout — dead entries would swallow
// approval decisions pushed via sendToMachine.
const PING_INTERVAL_MS = 30_000;
const keepalive = setInterval(() => {
	for (const set of connections.values()) {
		for (const conn of set) {
			if (!conn.isAlive) {
				conn.ws.terminate();
				continue;
			}
			conn.isAlive = false;
			conn.ws.ping();
		}
	}
}, PING_INTERVAL_MS);
keepalive.unref();

function send(ws: WebSocket, msg: DownstreamMessage): void {
	if (ws.readyState !== ws.OPEN) return;
	ws.send(JSON.stringify(msg));
}

export function connectionStats(): { machines: number } {
	return { machines: connections.size };
}
