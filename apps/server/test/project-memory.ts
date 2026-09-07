import assert from "node:assert/strict";
import { computeNextInspectionAt, type InspectionDelta, type InspectionSchedule } from "@pi-kanban/shared";
import { addProjectReadCoverage, buildStructureTree, collectToolCallFiles, mergeSnapshotTree } from "../src/project-tree.js";
import {
	CONNECTION_TEST_TIMEOUT_MS,
	FULL_INSPECTION_TIMEOUT_MS,
	MAX_AGENT_ROUNDS,
	MAX_AGENT_TOOL_CALLS,
	parseInspectionResult,
	readResponseText,
	requestInspection,
	requestInspectionAgent,
	requestInspectionStreaming,
	ToolCapabilityError,
} from "../src/model.js";
import {
	assembleInspectionInput,
	INPUT_LIMITS,
	INSPECTION_LOCK_TTL_MS,
	MAX_INSPECTION_BATCHES,
	mergeInspectionResults,
	redactInspectionResult,
	retainStructureModuleIds,
	splitInspectionBatches,
	isStrictlyEmptyUuidSession,
	toInspectionConnection,
} from "../src/inspector.js";
import { decryptApiKey, encryptApiKey, planInspectionSchedule, validateModelSettings } from "../src/model-settings.js";
import {
	getLiveInspection,
	recordInspectionDelta,
	recordInspectionStage,
	subscribeInspectionLive,
	type InspectionLiveEvent,
} from "../src/inspection-live.js";
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
		windowStartMinute: 540,
		windowEndMinute: 1080,
		weekdays: [5, 4, 3, 2, 1],
	}), {
		baseUrl: "https://model.example.test/v1",
		model: "test-model",
		enabled: true,
		intervalMinutes: 15,
		windowStartMinute: 540,
		windowEndMinute: 1080,
		weekdays: [1, 2, 3, 4, 5],
	});
	const validSchedule = { windowStartMinute: 0, windowEndMinute: 1439, weekdays: [0, 1, 2, 3, 4, 5, 6] as number[] };
	assert.throws(() => validateModelSettings({ baseUrl: "file:///tmp/model", model: "x", enabled: false, intervalMinutes: 15, ...validSchedule }));
	// http with any host is allowed (e.g. service names on a private network)
	assert.equal(validateModelSettings({ baseUrl: "http://model.example.test/v1", model: "x", enabled: false, intervalMinutes: 15, ...validSchedule }).baseUrl, "http://model.example.test/v1");
	assert.throws(() => validateModelSettings({ baseUrl: "https://user:pass@example.test/v1", model: "x", enabled: false, intervalMinutes: 15, ...validSchedule }));
	assert.throws(() => validateModelSettings({ baseUrl: "https://example.test", model: "x", enabled: false, intervalMinutes: 1, ...validSchedule }));
	assert.throws(() => validateModelSettings({ baseUrl: "https://example.test", model: "x", enabled: false, intervalMinutes: 45, ...validSchedule }));
	// schedule window/weekday validation
	assert.throws(() => validateModelSettings({ baseUrl: "https://example.test", model: "x", enabled: false, intervalMinutes: 15, windowStartMinute: 720, windowEndMinute: 720, weekdays: [1] }));
	assert.throws(() => validateModelSettings({ baseUrl: "https://example.test", model: "x", enabled: false, intervalMinutes: 15, windowStartMinute: 1440, windowEndMinute: 1439, weekdays: [1] }));
	assert.throws(() => validateModelSettings({ baseUrl: "https://example.test", model: "x", enabled: false, intervalMinutes: 15, windowStartMinute: 0, windowEndMinute: 1440, weekdays: [1] }));
	assert.throws(() => validateModelSettings({ baseUrl: "https://example.test", model: "x", enabled: false, intervalMinutes: 15, windowStartMinute: 0, windowEndMinute: 1439, weekdays: [] }));
	assert.throws(() => validateModelSettings({ baseUrl: "https://example.test", model: "x", enabled: false, intervalMinutes: 15, windowStartMinute: 0, windowEndMinute: 1439, weekdays: [7] }));
	assert.throws(() => validateModelSettings({ baseUrl: "https://example.test", model: "x", enabled: false, intervalMinutes: 15, windowStartMinute: 0, windowEndMinute: 1439, weekdays: [1, 1] }));
	assert.equal(validateModelSettings({ baseUrl: "http://localhost:11434/v1", model: "x", enabled: false, intervalMinutes: 15, ...validSchedule }).baseUrl, "http://localhost:11434/v1");

	const settingsRow = {
		id: 1,
		baseUrl: "https://model.example.test/v1",
		model: "test-model",
		apiKeyCipher: encrypted,
		enabled: false,
		inspectionIntervalMinutes: 30,
		inspectionWindowStart: 540,
		inspectionWindowEnd: 1080,
		inspectionWeekdays: 62, // bits 1-5 = Mon-Fri
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
		schedule: { intervalMinutes: 30, windowStartMinute: 540, windowEndMinute: 1080, weekdays: [1, 2, 3, 4, 5] },
	});

	// split request budgets: slow full inspection, fast connection test, and a
	// lock TTL generous enough that a legitimate run is never re-claimed mid-flight
	assert.equal(FULL_INSPECTION_TIMEOUT_MS, 10 * 60_000);
	assert.equal(CONNECTION_TEST_TIMEOUT_MS, 30_000);
	assert.equal(MAX_INSPECTION_BATCHES, 4);
	assert.equal(MAX_AGENT_ROUNDS, 6);
	assert.equal(MAX_AGENT_TOOL_CALLS, 12);
	assert.equal(INSPECTION_LOCK_TTL_MS, (MAX_AGENT_ROUNDS + 1) * FULL_INSPECTION_TIMEOUT_MS);

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
			{ kind: "decision", content: "Use PostgreSQL for durable state", confidence: "high", moduleIds: ["path:apps/server"], evidence: [{ sessionId: "s1", turnPosition: 2 }] },
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
	assert.equal(
		parseInspectionResult(JSON.stringify({ memories: [{ kind: "fact", content: "unsupported confidence", moduleIds: [], evidence: [] }], tree: [] })).memories.length,
		0,
		"memories without high-confidence evidence must not enter the automatic path",
	);
	const outputWithPii = redactInspectionResult({
		memories: [{ kind: "fact", content: "Owner is alice" + "@example.com", confidence: "high", moduleIds: [], evidence: [] }],
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
	assert.equal(tree.find((node) => node.id === "file:README.md")?.kind, "file", "root files are file nodes, not modules");
	assert.equal(tree.find((node) => node.id === "path:apps/web")?.fileCount, 2, "directory nodes carry a structured file count (client localizes the label)");
	const coverage = addProjectReadCoverage(tree, [
		{ path: "apps/web/src/main.tsx" },
		{ path: "apps/web/src/App.tsx" },
		{ path: "packages/shared/src/index.ts" },
		{ path: "README.md" },
	], [
		{ cwd: "D:/work/pi-kanban", toolName: "read", input: { path: "apps/web/src/main.tsx" } },
		{ cwd: "D:/work/pi-kanban", toolName: "functions.read_symbol", input: { path: "D:\\work\\pi-kanban\\packages\\shared\\src\\index.ts" } },
		{ cwd: "D:/work/pi-kanban", toolName: "bash", input: { path: "apps/web/src/App.tsx" } },
	]);
	assert.equal(coverage.totalFiles, 4);
	assert.equal(coverage.readFiles, 2, "only file-reading tools count toward session coverage");
	assert.deepEqual(coverage.tree.find((node) => node.id === "project")?.coverage, { totalFiles: 4, readFiles: 2 });
	assert.deepEqual(coverage.tree.find((node) => node.id === "path:apps")?.coverage, { totalFiles: 2, readFiles: 1 });

	// A snapshot upload rebuilds structure but must preserve inspection insight
	// nodes (decision/milestone/issue/evidence) already merged into latestTree.
	const withInsights = mergeSnapshotTree([
		{ id: "project", kind: "project", label: "pi-kanban" },
		{ id: "path:stale", kind: "module", label: "stale" },
		{ id: "insight:1", kind: "decision", label: "Use mergeProjectTree", parentId: "path:apps/web" },
		{ id: "insight:2", kind: "issue", label: "Flaky test", parentId: "path:gone" },
		{ id: "garbage", label: 42 },
		null,
	], [
		{ path: "apps/web/src/main.tsx" },
		{ path: "README.md" },
	], "pi-kanban");
	assert.ok(withInsights.some((node) => node.id === "path:apps/web/src"), "fresh structure present");
	assert.ok(!withInsights.some((node) => node.id === "path:stale"), "stale structure replaced");
	assert.equal(withInsights.find((node) => node.id === "insight:1")?.parentId, "path:apps/web", "insight keeps a still-valid structure parent");
	assert.equal(withInsights.find((node) => node.id === "insight:2")?.parentId, "project", "insight with a gone parent reattaches to the project root");
	assert.equal(withInsights.filter((node) => node.kind === "decision" || node.kind === "issue").length, 2, "malformed entries dropped");

	// Snapshot-less projects derive their file list from session tool calls.
	const derivedFiles = collectToolCallFiles([
		{ cwd: "D:/work/pi-kanban", toolName: "read", input: { path: "apps/web/src/main.tsx" } },
		{ cwd: "D:/work/pi-kanban", toolName: "edit", input: { path: "apps/web/src/App.tsx" } },
		{ cwd: "D:/work/pi-kanban", toolName: "write", input: { path: "apps/web/src/App.tsx" } },
		{ cwd: "D:/work/pi-kanban", toolName: "bash", input: { command: "ls apps" } },
		{ cwd: "D:/work/pi-kanban", toolName: "grep", input: { path: "apps" } },
		{ cwd: "D:/work/pi-kanban", toolName: "read", input: { path: "C:/elsewhere/secret.ts" } },
	]);
	assert.deepEqual(derivedFiles, [
		{ path: "apps/web/src/App.tsx" },
		{ path: "apps/web/src/main.tsx" },
	], "only file-touching tools contribute, deduped and sorted, outside-root paths excluded");

	const emptySession = {
		id: "01a075f7-b159-7691-9ba1-615be92378fc",
		title: null,
		branch: null,
		modelId: null,
		turnCount: 0,
		totalCostUsd: 0,
		inputTokens: 0,
		cacheReadTokens: 0,
		totalTokens: 0,
		contextTokens: 0,
		contextWindow: 0,
	};
	assert.equal(isStrictlyEmptyUuidSession(emptySession), true);
	assert.equal(isStrictlyEmptyUuidSession({ ...emptySession, title: "kept metadata" }), false);
	assert.equal(isStrictlyEmptyUuidSession({ ...emptySession, id: "ephemeral" }), false);

	// --- settings → schedule coordination (pure planner) ----------------------
	// All dates are constructed in local time because the schedule itself is
	// defined in the machine's local time zone.
	const workweek = (over: Partial<InspectionSchedule> = {}): InspectionSchedule => ({
		intervalMinutes: 60,
		windowStartMinute: 0,
		windowEndMinute: 1439,
		weekdays: [0, 1, 2, 3, 4, 5, 6],
		...over,
	});
	const plannedNow = new Date(2026, 0, 1, 12, 0); // Thursday
	// no settings yet / staying disabled: schedules untouched
	assert.deepEqual(planInspectionSchedule(undefined, { enabled: false, schedule: workweek() }, plannedNow), { type: "none" });
	assert.deepEqual(planInspectionSchedule({ enabled: false, schedule: workweek() }, { enabled: false, schedule: workweek() }, plannedNow), { type: "none" });
	// only the enable transition schedules projects: idle states run at the
	// schedule's next slot (12:00 is itself a slot for an all-day hourly window)
	assert.deepEqual(planInspectionSchedule(undefined, { enabled: true, schedule: workweek() }, plannedNow), { type: "reschedule-idle", nextAt: new Date(2026, 0, 1, 12, 0) });
	assert.deepEqual(planInspectionSchedule({ enabled: false, schedule: workweek() }, { enabled: true, schedule: workweek({ intervalMinutes: 1440 }) }, plannedNow), { type: "reschedule-idle", nextAt: new Date(2026, 0, 2, 0, 0) });
	// re-saving identical settings must not reset schedules; weekday order alone is not a change
	assert.deepEqual(planInspectionSchedule({ enabled: true, schedule: workweek() }, { enabled: true, schedule: workweek() }, plannedNow), { type: "none" });
	assert.deepEqual(
		planInspectionSchedule({ enabled: true, schedule: workweek({ weekdays: [1, 2, 3, 4, 5] }) }, { enabled: true, schedule: workweek({ weekdays: [5, 4, 3, 2, 1] }) }, plannedNow),
		{ type: "none" },
	);
	// schedule change while enabled: idle states restart from the new schedule
	assert.deepEqual(
		planInspectionSchedule({ enabled: true, schedule: workweek() }, { enabled: true, schedule: workweek({ intervalMinutes: 1440 }) }, plannedNow),
		{ type: "reschedule-idle", nextAt: new Date(2026, 0, 2, 0, 0) },
	);
	// disabling stops future scheduled runs but leaves any live lock alone
	assert.deepEqual(planInspectionSchedule({ enabled: true, schedule: workweek() }, { enabled: false, schedule: workweek() }, plannedNow), { type: "clear-schedule" });

	// --- cron-like slot computation --------------------------------------------
	// 2026-01-01 is a Thursday; window 09:00–18:00 every 30 min, Mon–Fri only.
	const office = workweek({ intervalMinutes: 30, windowStartMinute: 540, windowEndMinute: 1080, weekdays: [1, 2, 3, 4, 5] });
	assert.equal(computeNextInspectionAt(office, new Date(2026, 0, 1, 8, 59)).getTime(), new Date(2026, 0, 1, 9, 0).getTime());
	assert.equal(computeNextInspectionAt(office, new Date(2026, 0, 1, 10, 7)).getTime(), new Date(2026, 0, 1, 10, 30).getTime());
	// slots are aligned to the window start, and `from` itself counts
	assert.equal(computeNextInspectionAt(office, new Date(2026, 0, 1, 10, 30)).getTime(), new Date(2026, 0, 1, 10, 30).getTime());
	// windowEnd is inclusive: 18:00 is still a slot, 18:00:30 is not
	assert.equal(computeNextInspectionAt(office, new Date(2026, 0, 1, 17, 45)).getTime(), new Date(2026, 0, 1, 18, 0).getTime());
	assert.equal(computeNextInspectionAt(office, new Date(2026, 0, 1, 18, 0, 30)).getTime(), new Date(2026, 0, 2, 9, 0).getTime());
	// weekend rolls to the next allowed weekday
	assert.equal(computeNextInspectionAt(office, new Date(2026, 0, 3, 12, 0)).getTime(), new Date(2026, 0, 5, 9, 0).getTime());
	// daily interval with an all-day window advances exactly one day
	assert.equal(computeNextInspectionAt(workweek({ intervalMinutes: 1440 }), new Date(2026, 0, 1, 10, 0)).getTime(), new Date(2026, 0, 2, 0, 0).getTime());

	// Model memory associations are bounded and deduplicated before persistence validation.
	assert.deepEqual(
		parseInspectionResult(JSON.stringify({
			memories: [{ kind: "fact", content: "module-scoped", confidence: "high", moduleIds: ["path:apps/web", "path:apps/web", "path:apps/server", "path:extra"], evidence: [] }],
			tree: [],
		})).memories,
		[{ kind: "fact", content: "module-scoped", confidence: "high", moduleIds: ["path:apps/web", "path:apps/server", "path:extra"], evidence: [] }],
	);

	assert.deepEqual(
		retainStructureModuleIds(
			[{ kind: "fact", content: "filtered", confidence: "high", moduleIds: ["path:apps/web", "bad", "path:apps/web", "path:apps/server"], evidence: [] }],
			new Set(["project", "path:apps/web"]),
		),
		[{ kind: "fact", content: "filtered", confidence: "high", moduleIds: ["path:apps/web"], evidence: [] }],
	);

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
	const batchedSections = {
		...sections,
		sessions: ["s1", "s2", "s3", "s4"].map((id) => ({ id, title: `session ${id}`, branch: "main", state: "idle", lastActivityAt: "2026-01-01T00:00:00.000Z" })),
		messages: ["s1", "s2", "s3", "s4"].map((sessionId, turnPosition) => ({ sessionId, turnPosition, role: "assistant", excerpt: `${sessionId} message` })),
		failedTools: ["s1", "s4"].map((sessionId) => ({ sessionId, toolName: "bash", result: "failed" })),
	};
	const batches = splitInspectionBatches(batchedSections);
	assert.equal(batches.length, 2);
	assert.deepEqual(batches.map((batch) => batch.sessions.map((session) => session.id)), [["s1", "s2", "s3"], ["s4"]]);
	assert.deepEqual(batches.map((batch) => batch.messages.map((message) => message.sessionId)), [["s1", "s2", "s3"], ["s4"]]);
	assert.deepEqual(batches.map((batch) => batch.failedTools.map((tool) => tool.sessionId)), [["s1"], ["s4"]]);
	const batchedInput = assembleInspectionInput(batches[0]!, { maxBytes: 100_000, batch: { index: 1, total: 2 } });
	assert.deepEqual((batchedInput.context as { batch?: unknown }).batch, { index: 1, total: 2 });
	const merged = mergeInspectionResults([
		{
			memories: [{ kind: "decision", content: "Use PostgreSQL", confidence: "high", moduleIds: [], evidence: [] }],
			tree: [{ id: "insight:0", kind: "issue", label: "first batch" }],
		},
		{
			memories: [
				{ kind: "decision", content: "use postgresql", confidence: "high", moduleIds: [], evidence: [] },
				{ kind: "fact", content: "second batch", confidence: "high", moduleIds: [], evidence: [] },
			],
			tree: [{ id: "insight:0", kind: "issue", label: "second batch" }],
		},
	]);
	assert.deepEqual(merged.memories.map((memory) => memory.content), ["Use PostgreSQL", "second batch"]);
	assert.deepEqual(merged.tree.map((node) => node.id), ["insight:0:0", "insight:1:0"]);

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
		// happy path: request shape, result parsing, and transcript capture
		fetchCalls.length = 0;
		mockFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ memories: [], tree: [] }) } }] }), { status: 200, headers: { "content-type": "application/json" } }));
		const happy = await requestInspection(testConnection, { project: { name: "pi-kanban" } }, { timeoutMs: 2_000, purpose: "unit" });
		assert.deepEqual(happy.result, { memories: [], tree: [] });
		assert.equal(happy.content, JSON.stringify({ memories: [], tree: [] }));
		assert.equal(happy.reasoning, undefined);
		assert.equal(fetchCalls.length, 1);
		assert.equal(fetchCalls[0]?.url, "https://model.example.test/v1/chat/completions");
		const sentBody = JSON.parse(String(fetchCalls[0]?.init?.body));
		assert.equal(sentBody.model, "test-model");
		assert.equal(sentBody.max_tokens, 8_192);
		assert.equal(sentBody.response_format.type, "json_object");
		assert.equal(sentBody.messages.length, 2);
		assert.ok(fetchCalls[0]?.init?.signal instanceof AbortSignal);
		fetchCalls.length = 0;
		mockFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ memories: [], tree: [] }) } }] }), { status: 200, headers: { "content-type": "application/json" } }));
		await requestInspection({ ...testConnection, model: "glm-5.3-flash" }, { project: { name: "pi-kanban" } }, { timeoutMs: 2_000, purpose: "unit" });
		const glmBody = JSON.parse(String(fetchCalls[0]?.init?.body));
		assert.equal(glmBody.max_tokens, 16_384);
		assert.equal(glmBody.response_format, undefined);
		let agentRequestCount = 0;
		const agentSteps: string[] = [];
		mockFetch(() => {
			agentRequestCount++;
			const message = agentRequestCount === 1
				? {
					tool_calls: [{ id: "call-sessions", type: "function", function: { name: "list_sessions", arguments: "{\"limit\":1}" } }],
				}
				: {
					tool_calls: [{ id: "call-finalize", type: "function", function: { name: "finalize_inspection", arguments: JSON.stringify({ memories: [], tree: [] }) } }],
				};
			return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { "content-type": "application/json" } });
		});
		const agent = await requestInspectionAgent(testConnection, { project: { name: "pi-kanban" } }, [{
			type: "function",
			function: { name: "list_sessions", description: "test", parameters: { type: "object" } },
		}], {
			executeTool: async (call) => ({ content: { sessions: [{ id: call.arguments.limit === 1 ? "s1" : "unexpected" }], detail: "x".repeat(20_000) }, redactionCount: 1, audit: { source: "test" } }),
			onTool: (step) => agentSteps.push(`${step.round}:${step.tool}:${step.status}`),
		});
		assert.deepEqual(agent.result, { memories: [], tree: [] });
		assert.equal(agentRequestCount, 2);
		assert.deepEqual(agentSteps, ["1:list_sessions:completed"]);
		assert.equal(agent.steps[0]?.redactionCount, 1);
		const agentFirstBody = JSON.parse(String(fetchCalls.at(-2)?.init?.body));
		const agentSecondBody = JSON.parse(String(fetchCalls.at(-1)?.init?.body));
		assert.equal(agentFirstBody.response_format, undefined, "tools must not be combined with JSON response_format");
		assert.equal(agentFirstBody.tools[0]?.function.name, "list_sessions");
		assert.equal(agentSecondBody.messages.at(-1)?.role, "tool");
		assert.ok(Buffer.byteLength(agentSecondBody.messages.at(-1)?.content ?? "") <= 16_000, "each tool result must respect its byte budget");
		mockFetch(() => new Response("tools unsupported", { status: 400 }));
		await assert.rejects(
			requestInspectionAgent(testConnection, {}, [], { executeTool: async () => ({ content: {}, redactionCount: 0, audit: {} }) }),
			ToolCapabilityError,
		);
		// reasoning_content / reasoning are surfaced for the inspection log panel
		mockFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ memories: [], tree: [] }), reasoning_content: " weighing evidence…" } }] }), { status: 200, headers: { "content-type": "application/json" } }));
		const withReasoning = await requestInspection(testConnection, {}, { timeoutMs: 2_000 });
		assert.equal(withReasoning.reasoning, " weighing evidence…");
		mockFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ memories: [], tree: [] }), reasoning: "alt key" } }] }), { status: 200, headers: { "content-type": "application/json" } }));
		const altReasoning = await requestInspection(testConnection, {}, { timeoutMs: 2_000 });
		assert.equal(altReasoning.reasoning, "alt key");
		// --- streaming variant: per-chunk deltas, assembly, split chunks, fallbacks ----
		const sseData = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
		const streamResponse = (body: string) => new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(body));
					controller.close();
				},
			}),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
		const payloadJson = JSON.stringify({ memories: [], tree: [] });
		const streamDeltas: InspectionDelta[] = [];
		let streamActivity = 0;
		mockFetch(() => streamResponse(
			sseData({ choices: [{ delta: { reasoning_content: "weighing " } }] }) +
			sseData({ choices: [{ delta: { reasoning_content: "evidence" } }] }) +
			sseData({ choices: [{ delta: { content: payloadJson.slice(0, 10) } }] }) +
			sseData({ choices: [{ delta: { content: payloadJson.slice(10) } }] }) +
			"data: [DONE]\n\n",
		));
		const streamed = await requestInspectionStreaming(testConnection, { project: { name: "x" } }, { timeoutMs: 2_000, onActivity: () => { streamActivity++; }, onDelta: (d) => streamDeltas.push(d) });
		assert.deepEqual(streamDeltas, [
			{ type: "reasoning", text: "weighing " },
			{ type: "reasoning", text: "evidence" },
			{ type: "content", text: payloadJson.slice(0, 10) },
			{ type: "content", text: payloadJson.slice(10) },
		], "deltas must arrive per chunk in order");
		assert.equal(streamed.reasoning, "weighing evidence");
		assert.equal(streamed.content, payloadJson);
		assert.deepEqual(streamed.result, { memories: [], tree: [] });
		assert.equal(streamActivity, 1, "one raw SSE body chunk reports stream activity even when it contains multiple events");
		assert.equal(JSON.parse(String(fetchCalls.at(-1)?.init?.body)).stream, true, "streaming requests must ask for stream:true");
		// A valid SSE stream may run longer than one timeout window as long as
		// each raw SSE chunk arrives before the idle deadline.
		mockFetch(() => new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(sseData({ choices: [{ delta: { content: payloadJson.slice(0, 10) } }] })));
					setTimeout(() => controller.enqueue(new TextEncoder().encode(sseData({ choices: [{ delta: { content: payloadJson.slice(10) } }] }))), 70);
					setTimeout(() => controller.close(), 190);
				},
			}),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		));
		const longLivedStream = await requestInspectionStreaming(testConnection, {}, { timeoutMs: 120 });
		assert.deepEqual(longLivedStream.result, { memories: [], tree: [] }, "SSE activity must reset the inspection idle timeout");
		// a chunk boundary splitting one SSE block mid-JSON must still assemble
		const splitEncoded = new TextEncoder().encode(sseData({ choices: [{ delta: { content: payloadJson } }] }) + "data: [DONE]\n\n");
		mockFetch(() => new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(splitEncoded.slice(0, 17));
					controller.enqueue(splitEncoded.slice(17));
					controller.close();
				},
			}),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		));
		const reassembled = await requestInspectionStreaming(testConnection, {}, { timeoutMs: 2_000 });
		assert.deepEqual(reassembled.result, { memories: [], tree: [] });
		// a \r\n pair split across chunk boundaries must not lose a block separator
		const crlfBlock = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\r\n\r\n`;
		const crlfEncoded = new TextEncoder().encode(
			crlfBlock(payloadJson.slice(0, 10)) + crlfBlock(payloadJson.slice(10)) + "data: [DONE]\r\n\r\n",
		);
		const crlfSplit = crlfBlock(payloadJson.slice(0, 10)).length - 1; // between the separator's final \r and \n
		const crlfDeltas: InspectionDelta[] = [];
		mockFetch(() => new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(crlfEncoded.slice(0, crlfSplit));
					controller.enqueue(crlfEncoded.slice(crlfSplit));
					controller.close();
				},
			}),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		));
		const crlfStreamed = await requestInspectionStreaming(testConnection, {}, { timeoutMs: 2_000, onDelta: (d) => crlfDeltas.push(d) });
		assert.deepEqual(crlfDeltas.map((d) => d.text), [payloadJson.slice(0, 10), payloadJson.slice(10)], "CRLF separators split across chunks must still delimit blocks");
		assert.deepEqual(crlfStreamed.result, { memories: [], tree: [] });
		// provider rejects streaming → exactly one buffered retry, result re-emitted as one delta batch
		let fallbackCalls = 0;
		mockFetch(() => {
			fallbackCalls++;
			return fallbackCalls === 1
				? new Response("streaming not supported", { status: 400 })
				: new Response(JSON.stringify({ choices: [{ message: { content: payloadJson } }] }), { status: 200, headers: { "content-type": "application/json" } });
		});
		const fallbackDeltas: InspectionDelta[] = [];
		const fellBack = await requestInspectionStreaming(testConnection, {}, { timeoutMs: 2_000, onDelta: (d) => fallbackDeltas.push(d) });
		assert.equal(fallbackCalls, 2, "exactly one buffered retry");
		assert.deepEqual(fallbackDeltas.map((d) => d.type), ["content"], "fallback text arrives as one batch");
		assert.deepEqual(fellBack.result, { memories: [], tree: [] });
		// A streaming fallback shares the first request's deadline; a late 400
		// cannot grant a second full timeout and overrun the inspection lock.
		let delayedFallbackCalls = 0;
		mockFetch(() => {
			delayedFallbackCalls++;
			if (delayedFallbackCalls === 1) {
				return new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("streaming not supported", { status: 400 })), 250));
			}
			return new Promise<Response>(() => {});
		});
		const fallbackStartedAt = Date.now();
		await assert.rejects(
			requestInspectionStreaming(testConnection, {}, { timeoutMs: 350, purpose: "fallback budget" }),
			/fallback budget timed out after 1s with no HTTP response/,
		);
		assert.equal(delayedFallbackCalls, 2);
		assert.ok(Date.now() - fallbackStartedAt < 500, "fallback must use only the original request's remaining budget");
		// provider ignores stream:true and answers JSON → parsed from the same response
		mockFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: payloadJson } }] }), { status: 200, headers: { "content-type": "application/json" } }));
		const ignoredDeltas: InspectionDelta[] = [];
		const ignoredStream = await requestInspectionStreaming(testConnection, {}, { timeoutMs: 2_000, onDelta: (d) => ignoredDeltas.push(d) });
		assert.deepEqual(ignoredDeltas.map((d) => d.type), ["content"]);
		assert.deepEqual(ignoredStream.result, { memories: [], tree: [] });
		// character cap enforced mid-stream
		mockFetch(() => streamResponse(sseData({ choices: [{ delta: { content: "x".repeat(400_001) } }] })));
		await assert.rejects(requestInspectionStreaming(testConnection, {}, { timeoutMs: 2_000 }), /exceeded the 400000 character limit/);
		// chatty provider: MBs of SSE envelope around tiny deltas must pass (payload caps still hold)
		const fatEnvelope = { id: "chatcmpl-x", object: "chat.completion.chunk", created: 1234567890, model: "test-model", system_fingerprint: "fp-0000000000000000000000000000", choices: [{ index: 0, delta: {}, finish_reason: null }] };
		const fatChunk = (text: string) => sseData({ ...fatEnvelope, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
		const longStream = () => {
			const parts: string[] = [fatChunk("{\"memories\":[],\"tree\":[]".slice(0, 1))];
			for (let i = 1; i < 20_000; i++) parts.push(fatChunk(" "));
			parts.push(fatChunk("}"));
			parts.push("data: [DONE]\n\n");
			return parts.join("");
		};
		mockFetch(() => streamResponse(longStream()));
		const chatty = await requestInspectionStreaming(testConnection, {}, { timeoutMs: 2_000 });
		assert.deepEqual(chatty.result, { memories: [], tree: [] }, "~5MB of envelope-heavy stream must assemble, not trip the wire cap");
		// runaway stream beyond the wire cap is still cut off
		const runaway = fatChunk(" ").repeat(80_000) + "data: [DONE]\n\n";
		mockFetch(() => streamResponse(runaway));
		await assert.rejects(requestInspectionStreaming(testConnection, {}, { timeoutMs: 2_000 }), /wire-byte limit/);
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

	// --- inspection live stage timeline (in-memory, replay semantics) ------------
	const label = (event: InspectionLiveEvent): string =>
		"stage" in event ? event.stage : "type" in event ? `delta:${event.type}` : "snapshot";
	{
		const seen: string[] = [];
		const unsubscribe = subscribeInspectionLive(7, (event) => seen.push(label(event)));
		recordInspectionStage(7, "manual", { stage: "assembled", inspectionId: "run-1", bytes: 512, redactions: 0, omitted: {} });
		recordInspectionStage(7, "manual", { stage: "request_sent", inspectionId: "run-1", model: "m", timeoutMs: 1_000 });
		assert.deepEqual(seen, ["assembled", "request_sent"]);
		assert.equal(getLiveInspection(7)?.running, true);
		recordInspectionStage(7, "manual", { stage: "succeeded", inspectionId: "run-1", memories: 1, treeNodes: 2, elapsedMs: 5 });
		assert.equal(getLiveInspection(7)?.running, false);
		unsubscribe();
		// A late subscriber replays the whole finished timeline, other projects stay isolated
		const replayed: string[] = [];
		subscribeInspectionLive(7, (event) => replayed.push(label(event)));
		assert.deepEqual(replayed, ["assembled", "request_sent", "succeeded"]);
		const other: string[] = [];
		subscribeInspectionLive(8, (event) => other.push(label(event)));
		assert.deepEqual(other, []);
		// A stage from a different inspectionId starts a fresh timeline instead of interleaving
		recordInspectionStage(7, "schedule", { stage: "assembled", inspectionId: "run-2", bytes: 8, redactions: 0, omitted: {} });
		const afterTakeover: string[] = [];
		subscribeInspectionLive(7, (event) => afterTakeover.push(label(event)));
		assert.deepEqual(afterTakeover, ["assembled"]);
	}
	// deltas: buffered per run, replayed as one snapshot on subscribe, stale-run deltas dropped
	{
		recordInspectionStage(9, "manual", { stage: "assembled", inspectionId: "run-9", bytes: 10, redactions: 0, omitted: {} });
		recordInspectionDelta(9, "run-9", { type: "reasoning", text: "think " });
		recordInspectionDelta(9, "run-9", { type: "reasoning", text: "more" });
		recordInspectionDelta(9, "run-9", { type: "content", text: "partial json" });
		recordInspectionDelta(9, "run-stale", { type: "content", text: "dropped" });
		const replayed: Array<{ kind: string; text?: string; reasoning?: string; content?: string }> = [];
		const unsubscribe = subscribeInspectionLive(9, (event) => {
			if ("stage" in event) replayed.push({ kind: "stage" });
			else if ("type" in event) replayed.push({ kind: `delta:${event.type}`, text: event.text });
			else replayed.push({ kind: "snapshot", reasoning: event.reasoning, content: event.content });
		});
		assert.deepEqual(replayed.map((e) => e.kind), ["stage", "snapshot"], "replay is stages then one text snapshot");
		assert.equal(replayed[1]?.reasoning, "think more");
		assert.equal(replayed[1]?.content, "partial json", "stale-run delta must be dropped");
		// live deltas flow through after the replay
		recordInspectionDelta(9, "run-9", { type: "content", text: "+tail" });
		assert.equal(replayed.at(-1)?.kind, "delta:content");
		assert.equal(replayed.at(-1)?.text, "+tail");
		unsubscribe();
	}

	console.log("project-memory tests passed");
} finally {
	if (priorSecret === undefined) delete process.env.MODEL_SETTINGS_SECRET;
	else process.env.MODEL_SETTINGS_SECRET = priorSecret;
}
