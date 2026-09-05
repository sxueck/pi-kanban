import assert from "node:assert/strict";
import { buildStructureTree } from "../src/project-tree.js";
import {
	CONNECTION_TEST_TIMEOUT_MS,
	FULL_INSPECTION_TIMEOUT_MS,
	parseInspectionResult,
	readResponseText,
	requestInspection,
} from "../src/model.js";
import {
	assembleInspectionInput,
	INPUT_LIMITS,
	INSPECTION_LOCK_TTL_MS,
	redactInspectionResult,
	toInspectionConnection,
} from "../src/inspector.js";
import { decryptApiKey, encryptApiKey, planInspectionSchedule, validateModelSettings } from "../src/model-settings.js";
import { redactForModel, redactText } from "../src/redact.js";

const priorSecret = process.env.MODEL_SETTINGS_SECRET;
process.env.MODEL_SETTINGS_SECRET = "test-only-model-settings-secret-32-characters";

try {
	const encrypted = encryptApiKey("provider-key-value");
	assert.notEqual(encrypted, "provider-key-value");
	assert.equal(decryptApiKey(encrypted), "provider-key-value");
	process.env.MODEL_SETTINGS_SECRET = "different-test-only-model-secret-32-chars";
	assert.throws(() => decryptApiKey(encrypted));
	process.env.MODEL_SETTINGS_SECRET = "test-only-model-settings-secret-32-characters";

	assert.deepEqual(validateModelSettings({
		baseUrl: "https://model.example.test/v1/",
		model: "test-model",
		enabled: true,
		intervalMinutes: 15,
	}), {
		baseUrl: "https://model.example.test/v1",
		model: "test-model",
		enabled: true,
		intervalMinutes: 15,
	});
	assert.throws(() => validateModelSettings({ baseUrl: "file:///tmp/model", model: "x", enabled: false, intervalMinutes: 15 }));
	assert.throws(() => validateModelSettings({ baseUrl: "http://model.example.test/v1", model: "x", enabled: false, intervalMinutes: 15 }));
	assert.throws(() => validateModelSettings({ baseUrl: "https://user:pass@example.test/v1", model: "x", enabled: false, intervalMinutes: 15 }));
	assert.throws(() => validateModelSettings({ baseUrl: "https://example.test", model: "x", enabled: false, intervalMinutes: 1 }));
	assert.throws(() => validateModelSettings({ baseUrl: "https://example.test", model: "x", enabled: false, intervalMinutes: 45 }));
	assert.equal(validateModelSettings({ baseUrl: "http://localhost:11434/v1", model: "x", enabled: false, intervalMinutes: 15 }).baseUrl, "http://localhost:11434/v1");

	const settingsRow = {
		id: 1,
		baseUrl: "https://model.example.test/v1",
		model: "test-model",
		apiKeyCipher: encrypted,
		enabled: false,
		inspectionIntervalMinutes: 30,
		updatedAt: new Date(),
	};
	assert.equal(toInspectionConnection(undefined), null);
	assert.equal(toInspectionConnection({ ...settingsRow, apiKeyCipher: null }), null);
	assert.equal(toInspectionConnection({ ...settingsRow, baseUrl: "" }), null);
	// manual inspection must work with the scheduled-inspection toggle off
	assert.deepEqual(toInspectionConnection(settingsRow), {
		baseUrl: "https://model.example.test/v1",
		model: "test-model",
		apiKeyCipher: encrypted,
		intervalMinutes: 30,
	});

	// split request budgets: slow full inspection, fast connection test, and a
	// lock TTL generous enough that a legitimate run is never re-claimed mid-flight
	assert.equal(FULL_INSPECTION_TIMEOUT_MS, 180_000);
	assert.equal(CONNECTION_TEST_TIMEOUT_MS, 30_000);
	assert.ok(INSPECTION_LOCK_TTL_MS > FULL_INSPECTION_TIMEOUT_MS);

	const sensitive = [
		"email=alice" + "@example.com",
		"host=192.168.10.20",
		"password" + "=do-not-store-this",
		"home=C:\\Users\\alice\\repo",
	].join(" ");
	const redacted = redactText(sensitive);
	assert.ok(redacted.count >= 4);
	assert.ok(!redacted.value.includes("alice@example.com"));
	assert.ok(!redacted.value.includes("192.168.10.20"));
	assert.ok(!redacted.value.includes("do-not-store-this"));
	assert.ok(!redacted.value.includes("C:\\Users\\alice"));
	const nested = redactForModel({ messages: [{ excerpt: sensitive }], count: 3 });
	assert.ok(nested.count >= 4);
	assert.equal(nested.value.count, 3);
	assert.equal(redactText(redacted.value).count, 0, "redaction must be idempotent");

	const parsed = parseInspectionResult(JSON.stringify({
		memories: [
			{ kind: "decision", content: "Use PostgreSQL for durable state", evidence: [{ sessionId: "s1", turnPosition: 2 }] },
			{ kind: "invalid", content: "drop me" },
		],
		tree: [
			{ kind: "issue", label: "Missing retry coverage", severity: "warning", sessionId: "s1" },
			{ kind: "unknown", label: "drop me" },
		],
	}));
	assert.equal(parsed.memories.length, 1);
	assert.equal(parsed.memories[0]?.evidence[0]?.sessionId, "s1");
	assert.equal(parsed.tree.length, 1);
	assert.equal(parsed.tree[0]?.kind, "issue");
	const outputWithPii = redactInspectionResult({
		memories: [{ kind: "fact", content: "Owner is alice" + "@example.com", evidence: [] }],
		tree: [{ id: "insight:1", kind: "issue", label: "Host 192.168.10.20" }],
	});
	assert.ok(outputWithPii.count >= 2);
	assert.ok(!outputWithPii.value.memories[0]?.content.includes("alice@example.com"));
	assert.ok(!outputWithPii.value.tree[0]?.label.includes("192.168.10.20"));
	assert.throws(() => parseInspectionResult("not-json"));
	await assert.rejects(readResponseText(new Response("12345"), 4), /size limit/);
	await assert.rejects(readResponseText(new Response("x", { headers: { "content-length": "10" } }), 4), /size limit/);

	const tree = buildStructureTree([
		{ path: "apps/web/src/main.tsx" },
		{ path: "apps/web/src/App.tsx" },
		{ path: "packages/shared/src/index.ts" },
		{ path: "README.md" },
	], "pi-kanban");
	assert.equal(tree[0]?.id, "project");
	assert.ok(tree.some((node) => node.id === "path:apps/web/src" && node.parentId === "path:apps/web"));
	assert.ok(tree.some((node) => node.id === "file:README.md" && node.parentId === "project"));

	// --- settings → schedule coordination (pure planner) ----------------------
	const plannedNow = new Date("2026-01-01T00:00:00.000Z");
	// no settings yet / staying disabled: schedules untouched
	assert.deepEqual(planInspectionSchedule(undefined, { enabled: false, intervalMinutes: 60 }, plannedNow), { type: "none" });
	assert.deepEqual(planInspectionSchedule({ enabled: false, intervalMinutes: 60 }, { enabled: false, intervalMinutes: 30 }, plannedNow), { type: "none" });
	// only the enable transition schedules projects (idle states run next sweep)
	assert.deepEqual(planInspectionSchedule(undefined, { enabled: true, intervalMinutes: 60 }, plannedNow), { type: "schedule-idle-now" });
	assert.deepEqual(planInspectionSchedule({ enabled: false, intervalMinutes: 60 }, { enabled: true, intervalMinutes: 1440 }, plannedNow), { type: "schedule-idle-now" });
	// re-saving identical settings must not reset schedules
	assert.deepEqual(planInspectionSchedule({ enabled: true, intervalMinutes: 60 }, { enabled: true, intervalMinutes: 60 }, plannedNow), { type: "none" });
	// interval change while enabled: reschedule idle states, never delay a due run
	assert.deepEqual(
		planInspectionSchedule({ enabled: true, intervalMinutes: 60 }, { enabled: true, intervalMinutes: 1440 }, plannedNow),
		{ type: "reschedule-idle", capAt: new Date("2026-01-02T00:00:00.000Z") },
	);
	// disabling stops future scheduled runs but leaves any live lock alone
	assert.deepEqual(planInspectionSchedule({ enabled: true, intervalMinutes: 60 }, { enabled: false, intervalMinutes: 60 }, plannedNow), { type: "clear-schedule" });

	// --- bounded, deterministic model input -----------------------------------
	assert.equal(INPUT_LIMITS.knownMemories, 200);
	assert.equal(INPUT_LIMITS.messages, 400);
	const sections = {
		project: { name: "pi-kanban", gitRemote: null },
		snapshot: { fileCount: 4, git: { head: "abc123", status: [] }, diagnostics: [], truncated: false },
		structureTree: tree,
		sessions: [{ id: "s1", title: "fix bug", branch: "main", state: "idle", lastActivityAt: "2026-01-01T00:00:00.000Z" }],
		messages: [
			{ sessionId: "s1", turnPosition: 1, role: "user", excerpt: "first message" },
			{ sessionId: "s1", turnPosition: 2, role: "assistant", excerpt: "second message" },
			{ sessionId: "s1", turnPosition: 3, role: "user", excerpt: "third message" },
		],
		failedTools: [],
		knownMemories: [{ id: "m1", kind: "fact", content: "already known", status: "confirmed" }],
	};
	const fullInput = assembleInspectionInput(sections, { maxBytes: 100_000 });
	// structure tree node ids are supplied so model parentId references resolve
	assert.ok((fullInput.structureTree as Array<{ id: string }>).some((node) => node.id === "path:apps/web/src"));
	assert.deepEqual(fullInput.context, { limits: INPUT_LIMITS, omitted: { sessions: 0, messages: 0, failedTools: 0, knownMemories: 0 } });
	// deterministic: same sections, same payload
	assert.deepEqual(assembleInspectionInput(sections, { maxBytes: 100_000 }), fullInput);
	// whole-item budgeting: size the budget so only the first two messages fit,
	// then the memory is dropped too and both omissions are reported
	const trimmedBase = assembleInspectionInput({ ...sections, messages: [], knownMemories: [] }, { maxBytes: 1_000_000 });
	const trimmedBaseBytes = Buffer.byteLength(JSON.stringify({
		project: trimmedBase.project,
		snapshot: trimmedBase.snapshot,
		structureTree: trimmedBase.structureTree,
		sessions: trimmedBase.sessions,
	}));
	const firstTwoMessages = Buffer.byteLength(JSON.stringify(sections.messages[0])) + 1 + Buffer.byteLength(JSON.stringify(sections.messages[1])) + 1;
	const tightInput = assembleInspectionInput(sections, { maxBytes: trimmedBaseBytes + firstTwoMessages + 4096 });
	assert.equal(tightInput.messages.length, 2);
	assert.deepEqual(tightInput.messages[0], sections.messages[0]);
	assert.deepEqual((tightInput.context as { omitted: { messages: number; knownMemories: number } }).omitted, {
		messages: 1,
		knownMemories: 1,
		sessions: 0,
		failedTools: 0,
	} as { messages: number; knownMemories: number; sessions: number; failedTools: number });
	// payload stays valid JSON and included evidence identifiers are untouched
	assert.deepEqual(JSON.parse(JSON.stringify(tightInput)), tightInput);
	assert.deepEqual(tightInput.messages[1], sections.messages[1]);
	// base sections alone exceeding the budget fails loudly — never string-truncated JSON
	assert.throws(
		() => assembleInspectionInput(sections, { maxBytes: 4_096 + 16 }),
		/exceed the \d+ byte budget; refusing to truncate serialized JSON/,
	);

	// --- request budgets and timeout messages (mocked fetch, no network) ------
	const realFetch = globalThis.fetch;
	const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const testConnection = { baseUrl: "https://model.example.test/v1", model: "test-model", apiKey: "test-key" };
	const mockFetch = (respond: () => Promise<Response> | Response) => {
		globalThis.fetch = ((_url: string, init?: RequestInit) => {
			fetchCalls.push({ url: _url, init });
			return respond();
		}) as typeof fetch;
	};
	// AbortSignal.timeout timers are unref'd in Node, so they cannot keep a bare
	// test script's event loop alive (the real server always has live sockets).
	const keepLoopAlive = setInterval(() => undefined, 5_000);
	try {
		// no HTTP response within budget → actionable header-phase timeout
		mockFetch(() => new Promise<Response>(() => {}));
		await assert.rejects(
			requestInspection(testConnection, { project: { name: "x" } }, { timeoutMs: 600, purpose: "budget probe" }),
			/budget probe timed out after 1s with no HTTP response: .*not retried automatically/,
		);
		// headers arrive but the body stalls → actionable body-read timeout
		mockFetch(() => new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "application/json" } }));
		await assert.rejects(
			requestInspection(testConnection, { project: { name: "x" } }, { timeoutMs: 600, purpose: "budget probe" }),
			/budget probe response body read timed out after 1s: .*not retried automatically/,
		);
		// happy path: request shape and result parsing
		fetchCalls.length = 0;
		mockFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ memories: [], tree: [] }) } }] }), { status: 200, headers: { "content-type": "application/json" } }));
		assert.deepEqual(
			await requestInspection(testConnection, { project: { name: "pi-kanban" } }, { timeoutMs: 2_000, purpose: "unit" }),
			{ memories: [], tree: [] },
		);
		assert.equal(fetchCalls.length, 1);
		assert.equal(fetchCalls[0]?.url, "https://model.example.test/v1/chat/completions");
		const sentBody = JSON.parse(String(fetchCalls[0]?.init?.body));
		assert.equal(sentBody.model, "test-model");
		assert.equal(sentBody.max_tokens, 8_192);
		assert.equal(sentBody.response_format.type, "json_object");
		assert.equal(sentBody.messages.length, 2);
		assert.ok(fetchCalls[0]?.init?.signal instanceof AbortSignal);
		// provider errors surface with status and excerpt
		mockFetch(() => new Response("upstream exploded", { status: 503 }));
		await assert.rejects(requestInspection(testConnection, {}, { timeoutMs: 2_000 }), /HTTP 503 upstream exploded/);
		// model output is bounded even when the envelope is well-formed
		mockFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: "x".repeat(400_001) } }] }), { status: 200, headers: { "content-type": "application/json" } }));
		await assert.rejects(requestInspection(testConnection, {}, { timeoutMs: 2_000 }), /exceeded the 400000 character limit/);
	} finally {
		clearInterval(keepLoopAlive);
		globalThis.fetch = realFetch;
	}

	console.log("project-memory tests passed");
} finally {
	if (priorSecret === undefined) delete process.env.MODEL_SETTINGS_SECRET;
	else process.env.MODEL_SETTINGS_SECRET = priorSecret;
}
