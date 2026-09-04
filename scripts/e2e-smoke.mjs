/**
 * End-to-end smoke test: plays a pi plugin over WebSocket against a running
 * server, exercises the approval loop through the REST API, and verifies the
 * board/history views. Requires the server on localhost:8787 with
 * AGENT_TOKEN=t / ADMIN_TOKEN=a and a migrated database.
 */
const WS_URL = "ws://localhost:8787/agent";
const API = "http://localhost:8787";
const ADMIN = { authorization: "Bearer a" };

const sessionId = `smoke-${Date.now()}`;
let position = 0;

function assert(cond, label) {
	if (!cond) {
		console.error(`✗ ${label}`);
		process.exit(1);
	}
	console.log(`✓ ${label}`);
}

const ws = new WebSocket(WS_URL);
const waiters = [];
function waitFor(predicate, label) {
	return new Promise((resolve, reject) => {
		waiters.push({ predicate, resolve, label });
	});
}
ws.onmessage = (ev) => {
	let msg;
	try {
		msg = JSON.parse(String(ev.data));
	} catch {
		return;
	}
	for (let i = waiters.length - 1; i >= 0; i--) {
		if (waiters[i].predicate(msg)) {
			waiters[i].resolve(msg);
			waiters.splice(i, 1);
		}
	}
};
function send(msg) {
	ws.send(JSON.stringify(msg));
}

await new Promise((resolve, reject) => {
	ws.onopen = resolve;
	ws.onerror = reject;
});

send({
	type: "hello",
	protocolVersion: 1,
	pluginVersion: "smoke",
	machineId: "smoke-machine",
	agentToken: "t",
});
const ack = await waitFor((m) => m.type === "hello_ack", "hello ack");
assert(ack.ok, "hello ack ok");

send({
	type: "session_start",
	sessionId,
	cwd: "/tmp/smoke-project",
	gitRemote: "git@github.com:example/smoke-project.git",
	gitBranch: "main",
	reason: "new",
	startedAt: Date.now(),
});

send({
	type: "turn_start",
	sessionId,
	position: 1,
	prompt: "smoke test the kanban",
	startedAt: Date.now(),
});

send({
	type: "message",
	sessionId,
	turnPosition: 1,
	position: ++position,
	role: "user",
	excerpt: "smoke test the kanban",
	timestamp: Date.now(),
});
send({
	type: "message",
	sessionId,
	turnPosition: 1,
	position: ++position,
	role: "assistant",
	excerpt: "running it now",
	usage: { cost: { total: 0.05 } },
	costUsd: 0.05,
	modelId: "gateway/test-model",
	timestamp: Date.now(),
});

send({
	type: "tool_call",
	sessionId,
	turnPosition: 1,
	toolCallId: "call-1",
	toolName: "bash",
	input: { command: "git push --force" },
	startedAt: Date.now(),
});

send({
	type: "approval_request",
	requestId: "smoke-approval",
	sessionId,
	toolCallId: "call-1",
	toolName: "bash",
	input: { command: "git push --force" },
	policyLabel: "git push",
	localPrompted: false,
	createdAt: Date.now(),
});
const created = await waitFor(
	(m) => m.type === "approval_created" && m.requestId === "smoke-approval",
	"approval created",
);
console.log(`  approvalId=${created.approvalId}`);

// Board should show the session waiting for approval.
let board = await (await fetch(`${API}/api/board`, { headers: ADMIN })).json();
let entry = board.find((s) => s.id === sessionId);
assert(entry && entry.state === "waiting_approval", "board shows waiting_approval");
assert(entry.pendingApprovals === 1, "board shows 1 pending approval");
assert(entry.totalCostUsd === 0.05, "cost accumulated (0.05)");

// Decide from the web side; plugin must receive the downstream decision.
// Register the waiter BEFORE the POST: the decision can race the HTTP response.
send({ type: "tool_result", sessionId, toolCallId: "call-1", isError: false, endedAt: Date.now(), durationMs: 120 });
const decisionPromise = waitFor(
	(m) => m.type === "approval_decision" && m.approvalId === created.approvalId,
	"plugin received decision",
);
const decisionRes = await fetch(`${API}/api/approvals/${created.approvalId}/decision`, {
	method: "POST",
	headers: { ...ADMIN, "content-type": "application/json" },
	body: JSON.stringify({ decision: "approved" }),
});
assert(decisionRes.ok, "REST decision accepted");
const decision = await decisionPromise;
assert(decision.decision === "approved", "decision is approved");

send({
	type: "todo_snapshot",
	sessionId,
	todos: [
		{ position: 0, content: "write smoke", state: "completed" },
		{ position: 1, content: "verify board", state: "in_progress" },
	],
	timestamp: Date.now(),
});
send({ type: "turn_end", sessionId, position: 1, endedAt: Date.now() });
send({ type: "session_end", sessionId, reason: "quit", endedAt: Date.now() });

// Give the server a beat, then verify final views.
await new Promise((r) => setTimeout(r, 300));

board = await (await fetch(`${API}/api/board`, { headers: ADMIN })).json();
assert(!board.some((s) => s.id === sessionId), "finished session leaves the board");

const history = await (await fetch(`${API}/api/history`, { headers: ADMIN })).json();
const project = history.find((p) => p.name === "smoke-project");
assert(project && project.sessionCount >= 1, "history groups by git project");
assert(project.totalCostUsd >= 0.05, "project cost aggregated");

const projectSessions = await (
	await fetch(`${API}/api/projects/${project.id}/sessions`, { headers: ADMIN })
).json();
const detailRow = projectSessions.find((s) => s.id === sessionId);
assert(detailRow && detailRow.state === "finished", "project session list shows finished");

const detail = await (await fetch(`${API}/api/sessions/${sessionId}`, { headers: ADMIN })).json();
assert(detail.turns.length === 1 && detail.turns[0].state === "done", "detail: 1 done turn");
assert(detail.messages.length === 2, "detail: 2 messages");
assert(detail.toolCalls.length === 1 && detail.toolCalls[0].durationMs === 120, "detail: tool call with duration");
assert(detail.todos.length === 2 && detail.todos[0].state === "completed", "detail: todo snapshot");
assert(detail.approvals.length === 1 && detail.approvals[0].status === "approved", "detail: approved audit trail");

// Unauthorized access must be rejected.
const unauthorized = await fetch(`${API}/api/board`);
assert(unauthorized.status === 401, "API rejects missing token");

ws.close();
console.log("\ne2e smoke: all green");
process.exit(0);
