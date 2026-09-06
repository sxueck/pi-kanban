import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { InspectionCard, MemoriesCard, ModuleDetails } from "../src/views/History.js";
import { appendLiveDelta, InspectionLogPanel, LiveStreamBlocks } from "../src/views/InspectionLogs.js";
import type { ProjectMemoryDTO } from "@pi-kanban/shared";

const memories: ProjectMemoryDTO[] = [
	{ id: "new", version: 1, kind: "fact", content: "New memory", status: "candidate", moduleIds: [], evidence: [], createdAt: 200 },
	{ id: "pin", version: 1, kind: "fact", content: "Pinned memory", status: "pinned", moduleIds: [], evidence: [], createdAt: 100 },
	{ id: "dec", version: 1, kind: "decision", content: "Decision memory", status: "candidate", moduleIds: [], evidence: [], createdAt: 50 },
];
const renderMemories = (filter: "all" | "candidate", pending = new Set<string>(), insights: Parameters<typeof MemoriesCard>[0]["insights"] = []) => renderToStaticMarkup(
	<MemoryRouter><MemoriesCard memories={memories} insights={insights} pending={pending} filter={filter} onFilter={() => {}} onStatus={() => {}} /></MemoryRouter>,
);
const all = renderMemories("all");
assert.ok(all.indexOf("Pinned memory") < all.indexOf("New memory"));
assert.equal(memories[0].id, "new", "sorting must not mutate the fetched resource");
// kind grouping: decisions render ahead of facts, each under its group header
assert.ok(all.indexOf("Decision memory") < all.indexOf("Pinned memory"), "decision group must precede fact group");
assert.equal((all.match(/memory-group-title/g) ?? []).length, 2, "one group header per present kind");
assert.ok(all.includes("memory-scroll"), "memory list must render inside the scroll container");
const pending = renderMemories("candidate", new Set(["new"]));
assert.ok(!pending.includes("Pinned memory"));
assert.equal((pending.match(/disabled=""/g) ?? []).length, 3, "all actions on the pending item must be disabled");
// root-level inspection insights render as a fallback group after the memory groups
const withInsights = renderMemories("all", new Set(), [
	{ id: "i1", kind: "issue", label: "Runner alias drift", severity: "warning", sessionId: "s9" },
]);
assert.ok(withInsights.includes("Inspection insights"));
assert.ok(withInsights.includes("Runner alias drift"));
assert.ok(withInsights.includes("severity-warning"));
assert.ok(withInsights.indexOf("Pinned memory") < withInsights.indexOf("Runner alias drift"), "insight group follows the memory groups");
const inspection = { enabled: true, intervalMinutes: 60, running: false, lastError: "previous-timeout" };
const idle = renderToStaticMarkup(<InspectionCard inspection={inspection} busy={false} onInspect={() => {}} onLogs={() => {}} />);
assert.ok(idle.includes("previous-timeout"));
assert.ok(idle.includes("Inspection logs"), "the log entry point must render");
const running = renderToStaticMarkup(<InspectionCard inspection={{ ...inspection, running: true }} busy={false} onInspect={() => {}} onLogs={() => {}} />);
assert.ok(!running.includes("previous-timeout"), "a new run must not display the previous failure");
assert.ok(running.includes('disabled=""'));
const starting = renderToStaticMarkup(<InspectionCard inspection={inspection} busy onInspect={() => {}} onLogs={() => {}} />);
assert.ok(!starting.includes("previous-timeout"));
assert.ok(starting.includes("inspection running"));
// log panel shell: static render never runs effects, so no EventSource fires
const logPanel = renderToStaticMarkup(<InspectionLogPanel projectId={1} onClose={() => {}} />);
assert.ok(logPanel.includes("log-panel"));
assert.ok(logPanel.includes("Inspection logs"));
assert.ok(logPanel.includes("Select a run"), "empty state renders before the history loads");
// live token stream blocks render the streamed text with a live badge
const liveBlocks = renderToStaticMarkup(<LiveStreamBlocks liveText={{ reasoning: "weighing evidence", content: '{"tree":' }} />);
assert.ok(liveBlocks.includes("Reasoning (live)"));
assert.ok(liveBlocks.includes("weighing evidence"));
assert.ok(liveBlocks.includes("Output (live)"));
assert.ok(liveBlocks.includes("live-dot"));
const emptyLive = renderToStaticMarkup(<LiveStreamBlocks liveText={{ reasoning: "", content: "" }} />);
assert.equal(emptyLive, "", "no live text yet renders nothing");
// live text accumulation is a pure append per delta type
assert.deepEqual(
	appendLiveDelta({ reasoning: "", content: "" }, { type: "reasoning", text: "a" }),
	{ reasoning: "a", content: "" },
);
assert.deepEqual(
	appendLiveDelta({ reasoning: "a", content: "x" }, { type: "content", text: "y" }),
	{ reasoning: "a", content: "xy" },
);
const moduleDetails = renderToStaticMarkup(
	<MemoryRouter><ModuleDetails
		node={{ id: "path:apps/web", parentId: "project", kind: "module", label: "web" }}
		insights={[{ id: "i1", kind: "decision", label: "Use mergeProjectTree", sessionId: "s1" }]}
		memories={[
			{ id: "linked", version: 1, kind: "fact", content: "Linked memory", status: "candidate", moduleIds: ["path:apps/web"], evidence: [{ sessionId: "s1", turnPosition: 2 }], createdAt: 300 },
			{ id: "other", version: 1, kind: "fact", content: "Other memory", status: "candidate", moduleIds: ["path:apps/server"], evidence: [{ sessionId: "s2" }], createdAt: 250 },
		]}
		sessions={[
			{ id: "s1", title: "Web session", state: "idle", turnCount: 1, totalCostUsd: 0, startedAt: 100 },
			{ id: "s2", title: "Server session", state: "idle", turnCount: 1, totalCostUsd: 0, startedAt: 100 },
		]}
		pending={new Set()}
		onStatus={() => {}}
	/></MemoryRouter>,
);
assert.ok(moduleDetails.includes("Linked memory"));
assert.ok(!moduleDetails.includes("Other memory"));
assert.ok(moduleDetails.includes("Web session"));
assert.ok(!moduleDetails.includes("Server session"));
assert.ok(moduleDetails.includes("Use mergeProjectTree"), "module-linked insights render in module details");
const legacyModuleDetails = renderToStaticMarkup(
	<MemoryRouter><ModuleDetails
		node={{ id: "path:apps/web", parentId: "project", kind: "module", label: "web" }}
		insights={[]}
		memories={[{ id: "legacy", version: 1, kind: "fact", content: "Legacy memory", status: "candidate", evidence: [], createdAt: 100 } as unknown as ProjectMemoryDTO]}
		sessions={[]}
		pending={new Set()}
		onStatus={() => {}}
	/></MemoryRouter>,
);
assert.ok(legacyModuleDetails.includes("Legacy memory") === false);
console.log("project-memory UI checks passed");
