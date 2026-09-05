import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { InspectionCard, MemoriesCard } from "../src/views/History.js";
import type { ProjectMemoryDTO } from "@pi-kanban/shared";

const memories: ProjectMemoryDTO[] = [
	{ id: "new", version: 1, kind: "fact", content: "New memory", status: "candidate", evidence: [], createdAt: 200 },
	{ id: "pin", version: 1, kind: "fact", content: "Pinned memory", status: "pinned", evidence: [], createdAt: 100 },
	{ id: "dec", version: 1, kind: "decision", content: "Decision memory", status: "candidate", evidence: [], createdAt: 50 },
];
const renderMemories = (filter: "all" | "candidate", pending = new Set<string>()) => renderToStaticMarkup(
	<MemoryRouter><MemoriesCard memories={memories} pending={pending} filter={filter} onFilter={() => {}} onStatus={() => {}} /></MemoryRouter>,
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
const inspection = { enabled: true, intervalMinutes: 60, running: false, lastError: "previous-timeout" };
const idle = renderToStaticMarkup(<InspectionCard inspection={inspection} busy={false} onInspect={() => {}} />);
assert.ok(idle.includes("previous-timeout"));
const running = renderToStaticMarkup(<InspectionCard inspection={{ ...inspection, running: true }} busy={false} onInspect={() => {}} />);
assert.ok(!running.includes("previous-timeout"), "a new run must not display the previous failure");
assert.ok(running.includes('disabled=""'));
const starting = renderToStaticMarkup(<InspectionCard inspection={inspection} busy onInspect={() => {}} />);
assert.ok(!starting.includes("previous-timeout"));
assert.ok(starting.includes("inspection running"));
console.log("project-memory UI checks passed");
