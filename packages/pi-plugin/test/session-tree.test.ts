import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import plugin from "../src/index.js";

type Handler = (...args: any[]) => unknown;

class FakeWebSocket {
	static readonly OPEN = 1;
	readyState = 3;
	onopen: (() => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;

	constructor(_url: string) {}

	close(): void {}

	send(_data: string): void {}
}

const previousWebSocket = globalThis.WebSocket;
Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });

try {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Handler>();
	const entries: Array<{ type: string; data: { text?: string } }> = [];
	const pi = {
		events: { on: () => {} },
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerEntryRenderer: () => {},
		registerTool: () => {},
		registerCommand(name: string, command: { handler: Handler }) {
			commands.set(name, command.handler);
		},
		appendEntry(type: string, data: { text?: string }) {
			entries.push({ type, data });
		},
		getSessionName: () => null,
	} as unknown as ExtensionAPI;
	const cwd = mkdtempSync(join(tmpdir(), "pikb-session-tree-"));
	process.env.PI_CODING_AGENT_DIR = cwd;
	plugin(pi);

	await handlers.get("session_start")?.({ reason: "new" }, {
		sessionManager: { getSessionId: () => "session-tree-test" },
		cwd,
	});
	await handlers.get("before_agent_start")?.({ prompt: "test", systemPrompt: "system" });
	await commands.get("kanban-status")?.({}, { ui: { notify: () => {} } });
	assert.match(entries.at(-1)?.data.text ?? "", /0\/1 turns injected/);

	handlers.get("session_tree")?.();
	await commands.get("kanban-status")?.({}, { ui: { notify: () => {} } });
	assert.doesNotMatch(entries.at(-1)?.data.text ?? "", /turns injected/);
} finally {
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: previousWebSocket });
}

console.log("session-tree: all checks passed");
