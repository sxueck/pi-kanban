import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import {
	registerConnection,
	sendToMachine,
	unregisterConnection,
	type AgentConnection,
} from "../src/ws.js";

const OPEN = 1;
const CLOSED = 3;

interface FakeSocket {
	readyState: number;
	OPEN: number;
	sent: string[];
	send(raw: string): void;
	terminate(): void;
	ping(): void;
}

function makeConn(
	userId: string,
	machineId: string,
	readyState = OPEN,
): { conn: AgentConnection; socket: FakeSocket } {
	const socket: FakeSocket = {
		readyState,
		OPEN,
		sent: [],
		send(raw: string) {
			this.sent.push(raw);
		},
		terminate() {},
		ping() {},
	};
	const conn: AgentConnection = {
		ws: socket as unknown as WebSocket,
		machineId,
		userId,
		authenticated: true,
		isAlive: true,
		queue: Promise.resolve(),
	};
	return { conn, socket };
}

const decision = {
	type: "approval_decision",
	approvalId: "appr-1",
	decision: "approved",
} as const;

const USER = "11111111-1111-1111-1111-111111111111";
const MACHINE = "3f1b3c96-d0e1-4ee9-b9d5-934fded8d08b";

// Two sessions on one machine: the approval belongs to A, but B connected
// later. The decision must reach A (and B; plugins filter by approvalId).
const sessionA = makeConn(USER, MACHINE);
const sessionB = makeConn(USER, MACHINE);
registerConnection(sessionA.conn);
registerConnection(sessionB.conn);
assert.equal(sendToMachine(USER, MACHINE, decision), true);
assert.equal(sessionA.socket.sent.length, 1, "approval owner must receive the decision");
assert.equal(sessionB.socket.sent.length, 1, "sibling connection is broadcast to as well");
assert.deepEqual(JSON.parse(sessionA.socket.sent[0]), decision);

// B closes first: its unregister must not empty the machine's slot —
// A is still connected and must keep receiving decisions.
unregisterConnection(sessionB.conn);
assert.equal(sendToMachine(USER, MACHINE, decision), true);
assert.equal(sessionA.socket.sent.length, 2, "surviving session must still receive after sibling close");

// A closed socket is skipped; the open sibling still gets the message.
const sessionC = makeConn(USER, MACHINE, CLOSED);
registerConnection(sessionC.conn);
assert.equal(sendToMachine(USER, MACHINE, decision), true);
assert.equal(sessionA.socket.sent.length, 3);
assert.equal(sessionC.socket.sent.length, 0, "non-OPEN sockets must not be sent to");

// All sockets closed -> machine effectively offline.
unregisterConnection(sessionC.conn);
sessionA.socket.readyState = CLOSED;
assert.equal(sendToMachine(USER, MACHINE, decision), false);
sessionA.socket.readyState = OPEN;

// Other machines / users are never contacted.
const other = makeConn("22222222-2222-2222-2222-222222222222", MACHINE);
registerConnection(other.conn);
assert.equal(sendToMachine(USER, MACHINE, decision), true);
assert.equal(other.socket.sent.length, 0);

// Cleanup module state.
unregisterConnection(sessionA.conn);
unregisterConnection(other.conn);
assert.equal(sendToMachine(USER, MACHINE, decision), false);

console.log("ws-connections: all checks passed");
