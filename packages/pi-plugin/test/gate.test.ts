import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalRequestMessage, GateConfig, GateRule, UpstreamMessage } from "@pi-kanban/shared";
import { matchRule, runGate } from "../src/gate.js";
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
	[
		"matchRule: fused then_run command faces bash rules (SoL-Pi Action Fusion)",
		async () => {
			const rules: GateRule[] = [
				{ tool: "bash", match: "\\brm\\s+(-[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)", flags: "i", label: "rm -rf" },
			];
			for (const toolName of ["edit", "write"]) {
				const rule = matchRule(rules, toolName, {
					path: "scripts/build.sh",
					edits: [{ oldText: "a", newText: "b" }],
					then_run: { command: "npm test && rm -rf dist", timeout: 60 },
				});
				assert.equal(rule?.label, "rm -rf", `${toolName} then_run.command must face bash rules`);
			}
		},
	],
	[
		"matchRule: edit payload text cannot trip a scoped bash rule",
		async () => {
			const rules: GateRule[] = [
				{ tool: "bash", match: "\\brm\\s+-rf\\b", flags: "i", label: "rm -rf" },
			];
			const rule = matchRule(rules, "edit", {
				path: "notes.md",
				edits: [{ oldText: "safe", newText: "run `rm -rf /tmp/x` to clean up" }],
			});
			assert.equal(rule, null, "dangerous string in file contents must not match a bash rule");
		},
	],
	[
		"matchRule: scoped rules see only the command field, not other input fields",
		async () => {
			const rules: GateRule[] = [
				{ tool: "bash", match: "\\brm\\s+-rf\\b", flags: "i", label: "rm -rf" },
			];
			assert.equal(
				matchRule(rules, "bash", { command: "ls", description: "docs: rm -rf explained" }),
				null,
				"a bash rule must match input.command only",
			);
			assert.ok(
				matchRule(rules, "bash", { command: "rm -rf build" }),
				"input.command stays the primary match target",
			);
		},
	],
	[
		"matchRule: powershell scope stays isolated from bash rules",
		async () => {
			const rules: GateRule[] = [
				{ tool: "bash", match: "\\brm\\s+-rf\\b", flags: "i", label: "rm -rf" },
				{ tool: "powershell", match: "\\bRemove-Item\\b", flags: "i", label: "Remove-Item" },
			];
			assert.equal(
				matchRule(rules, "powershell", { command: "Remove-Item -Recurse dist" })?.label,
				"Remove-Item",
			);
			assert.equal(
				matchRule(rules, "powershell", { command: "bash -c 'rm -rf x'" }),
				null,
				"a powershell command string must not face bash rules",
			);
		},
	],
	[
		"matchRule: unscoped rules keep the legacy whole-input JSON match",
		async () => {
			const rules: GateRule[] = [{ match: "deploy-key", flags: "i", label: "deploy key" }];
			assert.ok(matchRule(rules, "read", { path: "/secrets/deploy-key.pem" }));
			assert.equal(matchRule(rules, "read", { path: "/etc/hosts" }), null);
		},
	],
	[
		"matchRule: edit/write without then_run is inert under scoped rules",
		async () => {
			const rules: GateRule[] = [
				{ tool: "bash", match: "\\brm\\s+-rf\\b", flags: "i", label: "rm -rf" },
			];
			assert.equal(matchRule(rules, "write", { path: "a.txt", content: "x" }), null);
			assert.equal(matchRule(rules, "edit", { path: "a.txt", edits: [] }), null);
		},
	],
	[
		"runGate: fused edit approval carries the real carrier tool and hit label",
		async () => {
			const transport = new FakeTransport();
			transport.connected = true;
			const { ctx } = makeCtx(true, false);
			const result = await runGate(
				{
					gate: makeGate({
						rules: [{ tool: "bash", match: "\\brm\\s+-rf\\b", flags: "i", label: "rm -rf" }],
					}),
					transport,
					getSessionId: () => "s1",
					getTurnPosition: () => 1,
				},
				{
					toolName: "edit",
					toolCallId: "tc-fused",
					input: { path: "a.sh", edits: [], then_run: { command: "rm -rf dist" } },
				},
				ctx,
			);
			assert.deepEqual(result, { block: true, reason: "Denied locally: rm -rf" });
			assert.equal(transport.requests[0]?.toolName, "edit");
			assert.equal(transport.requests[0]?.policyLabel, "rm -rf");
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
