import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalRequestMessage, GateConfig, UpstreamMessage } from "@pi-kanban/shared";
import { runGate } from "../src/gate.js";
import type { GateTransport } from "../src/gate.js";
import type { DecisionVerdict } from "../src/transport.js";
import { Transport } from "../src/transport.js";
import { TurnState } from "../src/turn-state.js";

const PUSH_EVENT = {
	toolName: "bash",
	toolCallId: "tc-1",
	input: { command: "git push origin main" },
};

function makeGate(overrides: Partial<GateConfig> = {}): GateConfig {
	return {
		rules: [{ tool: "bash", match: "\\bgit\\s+push\\b", flags: "i", label: "git push" }],
		localTimeoutSec: 5,
		cloudTimeoutSec: 5,
		onTimeout: "deny",
		escalateWhenHeadless: true,
		...overrides,
	};
}

class FakeTransport implements GateTransport {
	connected = false;
	approvalCreated = true;
	requests: Omit<ApprovalRequestMessage, "requestId">[] = [];
	sends: UpstreamMessage[] = [];
	decisionSink: ((verdict: DecisionVerdict) => void) | null = null;

	send(msg: UpstreamMessage): void {
		this.sends.push(msg);
	}

	async requestApproval(
		msg: Omit<ApprovalRequestMessage, "requestId">,
	): Promise<string | null> {
		this.requests.push(msg);
		if (!this.approvalCreated) {
			this.connected = false; // server died around the request
			return null;
		}
		return `appr-${this.requests.length}`;
	}

	waitForDecision(
		_id: string,
		onDecision: (verdict: DecisionVerdict) => void,
	): () => void {
		this.decisionSink = onDecision;
		return () => {
			this.decisionSink = null;
		};
	}
}

function makeCtx(hasUI: boolean, localAnswer?: boolean): {
	ctx: ExtensionContext;
	confirmCalls: () => number;
} {
	let confirmCalls = 0;
	const ctx = {
		hasUI,
		ui: {
			confirm: async () => {
				confirmCalls++;
				return localAnswer ?? true;
			},
		},
	};
	return { ctx: ctx as unknown as ExtensionContext, confirmCalls: () => confirmCalls };
}

class MockWebSocket {
	static readonly OPEN = 1;
	readonly sent: string[] = [];
	readyState = MockWebSocket.OPEN;
	onopen: (() => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;

	constructor(_url: string) {
		mockSockets.push(this);
	}

	open(): void {
		this.onopen?.();
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = 3;
		this.onclose?.();
	}

	message(data: unknown): void {
		this.onmessage?.({ data } as MessageEvent);
	}
}

const mockSockets: MockWebSocket[] = [];

function approvalRequest(toolCallId: string): Omit<ApprovalRequestMessage, "requestId"> {
	return {
		type: "approval_request",
		sessionId: "s1",
		toolCallId,
		toolName: "bash",
		input: { command: "git push" },
		policyLabel: "git push",
		localPrompted: false,
		createdAt: Date.now(),
	};
}

const tests: Array<[string, () => Promise<void>]> = [
	[
		"turn state: every session starts at position one and preserves event linkage",
		async () => {
			const turns = new TurnState();
			turns.reset();
			assert.equal(turns.current, undefined);
			assert.equal(turns.start(), 1);
			assert.equal(turns.current, 1);
			assert.equal(turns.finish(), 1);
			assert.equal(turns.current, undefined);
			turns.reset();
			assert.equal(turns.start(), 1);
			assert.equal(turns.start(), 2);
		},
	],
	[
		"offline + TUI: rule matches but plugin is inert — no prompt, no request, allowed",
		async () => {
			const transport = new FakeTransport();
			const { ctx, confirmCalls } = makeCtx(true, true);
			const result = await runGate(
				{ gate: makeGate(), transport, getSessionId: () => "s1", getTurnPosition: () => 1 },
				PUSH_EVENT,
				ctx,
			);
			assert.equal(result, undefined);
			assert.equal(confirmCalls(), 0);
			assert.equal(transport.requests.length, 0);
		},
	],
	[
		"offline + headless: allowed, nothing sent",
		async () => {
			const transport = new FakeTransport();
			const { ctx } = makeCtx(false);
			const result = await runGate(
				{ gate: makeGate(), transport, getSessionId: () => "s1", getTurnPosition: () => 1 },
				PUSH_EVENT,
				ctx,
			);
			assert.equal(result, undefined);
			assert.equal(transport.requests.length, 0);
		},
	],
	[
		"online + local deny: still blocks (online path preserved)",
		async () => {
			const transport = new FakeTransport();
			transport.connected = true;
			const { ctx } = makeCtx(true, false);
			const result = await runGate(
				{ gate: makeGate(), transport, getSessionId: () => "s1", getTurnPosition: () => 1 },
				PUSH_EVENT,
				ctx,
			);
			assert.deepEqual(result, { block: true, reason: "Denied locally: git push" });
		},
	],
	[
		"online + headless + escalation disabled: still blocks (config honored when online)",
		async () => {
			const transport = new FakeTransport();
			transport.connected = true;
			const { ctx } = makeCtx(false);
			const result = await runGate(
				{
					gate: makeGate({ escalateWhenHeadless: false, localTimeoutSec: 0 }),
					transport,
					getSessionId: () => "s1",
					getTurnPosition: () => 1,
				},
				PUSH_EVENT,
				ctx,
			);
			assert.equal(result?.block, true);
		},
	],
	[
		"connection drops right before the cloud request: allowed, not treated as timeout-deny",
		async () => {
			const transport = new FakeTransport();
			transport.connected = true;
			transport.approvalCreated = false; // requestApproval flips connected off
			const { ctx } = makeCtx(false);
			const result = await runGate(
				{
					gate: makeGate({ localTimeoutSec: 0 }),
					transport,
					getSessionId: () => "s1",
					getTurnPosition: () => 1,
				},
				PUSH_EVENT,
				ctx,
			);
			assert.equal(result, undefined);
			assert.equal(transport.requests.length, 1);
		},
	],
	[
		"connection drops while awaiting the decision: released as offline, allowed",
		async () => {
			const transport = new FakeTransport();
			transport.connected = true;
			const { ctx } = makeCtx(false);
			const pending = runGate(
				{ gate: makeGate({ localTimeoutSec: 0 }), transport, getSessionId: () => "s1", getTurnPosition: () => 1 },
				PUSH_EVENT,
				ctx,
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.ok(transport.decisionSink, "decision wait should be registered");
			transport.decisionSink("offline");
			assert.equal(await pending, undefined);
		},
	],
	[
		"interactive rule (ask_user): local confirm answers so the session unsticks",
		async () => {
			const transport = new FakeTransport();
			transport.connected = true;
			const { ctx, confirmCalls } = makeCtx(true, true);
			const pending = runGate(
				{
					gate: makeGate({ rules: [{ tool: "ask_user", label: "ask user", interactive: true }] }),
					transport,
					getSessionId: () => "s1",
					getTurnPosition: () => 1,
				},
				{ toolName: "ask_user", toolCallId: "tc-a", input: { questions: [] } },
				ctx,
			);
			await pending;
			assert.equal(confirmCalls(), 1, "interactive rules prompt locally too");
			assert.equal(transport.requests.length, 1);
			assert.equal(transport.requests[0].toolName, "ask_user");
			assert.equal(transport.requests[0].localPrompted, true);
		},
	],
	[
		"interactive rule (ask_user): cloud deny blocks the call so the session unsticks",
		async () => {
			const transport = new FakeTransport();
			transport.connected = true;
			const { ctx } = makeCtx(false);
			const pending = runGate(
				{
					gate: makeGate({ rules: [{ tool: "ask_user", label: "ask user", interactive: true }] }),
					transport,
					getSessionId: () => "s1",
					getTurnPosition: () => 1,
				},
				{ toolName: "ask_user", toolCallId: "tc-b", input: { questions: [] } },
				ctx,
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
			transport.decisionSink!("denied");
			assert.deepEqual(await pending, { block: true, reason: "Denied (ask user)" });
		},
	],
	[
		"real Transport: concurrent approval requests keep their own IDs",
		async () => {
			const originalWebSocket = globalThis.WebSocket;
			(globalThis as { WebSocket: typeof WebSocket }).WebSocket = MockWebSocket as unknown as typeof WebSocket;
			try {
				const transport = new Transport("ws://test/agent", "token");
				transport.connect();
				const socket = mockSockets.at(-1)!;
				socket.open();
				const first = transport.requestApproval(approvalRequest("tc-1"));
				const second = transport.requestApproval(approvalRequest("tc-2"));
				const sent = socket.sent.slice(-2).map((raw) => JSON.parse(raw));
				assert.notEqual(sent[0].requestId, sent[1].requestId);
				socket.message(JSON.stringify({
					type: "approval_created",
					requestId: sent[1].requestId,
					approvalId: "appr-2",
				}));
				assert.equal(await second, "appr-2");
				socket.message(JSON.stringify({
					type: "approval_created",
					requestId: sent[0].requestId,
					approvalId: "appr-1",
				}));
				assert.equal(await first, "appr-1");
			} finally {
				(globalThis as { WebSocket: typeof WebSocket }).WebSocket = originalWebSocket;
			}
		},
	],
	[
		"real Transport: close() releases pending decision waiters with offline",
		async () => {
			const transport = new Transport("ws://127.0.0.1:1/agent", "token");
			transport.connect();
			const verdicts: DecisionVerdict[] = [];
			transport.waitForDecision("appr-x", (verdict) => verdicts.push(verdict));
			transport.close();
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.deepEqual(verdicts, ["offline"]);
		},
	],
];

let failed = 0;
for (const [name, body] of tests) {
	try {
		await body();
		console.log(`ok - ${name}`);
	} catch (error) {
		failed++;
		console.error(`FAIL - ${name}`);
		console.error(error);
	}
}
if (failed > 0) process.exit(1);
console.log(`\n${tests.length - failed}/${tests.length} passed`);
