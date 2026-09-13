import assert from "node:assert/strict";
import { MIN_GLOBAL_PROJECTS, assembleGlobalInspectionInput, globalInspectionEligibleUsersQuery } from "../src/global-inspector.js";

function memory(id: string, content: string): Record<string, unknown> {
	return { id, kind: "decision", content, status: "confirmed", occurrenceCount: 1 };
}

// Small inputs pass through with projects intact and no omissions.
{
	const input = assembleGlobalInspectionInput({
		globalDecisions: [{ id: "g1", kind: "decision", content: "use pnpm everywhere", status: "pinned", occurrenceCount: 2 }],
		projects: [
			{ projectId: 1, name: "alpha", memories: [memory("a1", "alpha decision"), memory("a2", "another")] },
			{ projectId: 2, name: "beta", memories: [memory("b1", "beta decision")] },
		],
	});
	assert.equal(input.globalDecisions.length, 1);
	assert.equal(input.projects.length, 2);
	assert.equal(input.projects[0].memories.length, 2);
	assert.deepEqual(input.context.omitted, { globalDecisions: 0, projectMemories: 0 });
}

// Byte budget drops whole memories and reports the count, never splitting JSON.
{
	const big = "x".repeat(4_000);
	const input = assembleGlobalInspectionInput({
		globalDecisions: [],
		projects: Array.from({ length: 40 }, (_, index) => ({
			projectId: index + 1,
			name: `project-${index}`,
			memories: [memory(`m${index}-1`, big), memory(`m${index}-2`, big), memory(`m${index}-3`, big)],
		})),
	}, { maxBytes: 60_000 });
	const includedMemories = input.projects.reduce((total, project) => total + ((project.memories as unknown[]).length), 0);
	assert.ok(includedMemories < 120);
	assert.ok(input.context.omitted.projectMemories >= 120 - includedMemories);
	// Every included memory is whole (content preserved verbatim).
	for (const project of input.projects) {
		for (const item of project.memories as Array<{ content: string }>) {
			assert.equal(item.content, big);
		}
	}
}

// Global decisions drop whole from the tail once the budget runs out.
{
	const big = "y".repeat(2_000);
	const input = assembleGlobalInspectionInput({
		globalDecisions: Array.from({ length: 60 }, (_, index) => ({ id: `g${index}`, kind: "decision", content: big, status: "pinned", occurrenceCount: 1 })),
		projects: [],
	}, { maxBytes: 40_000 });
	assert.ok(input.globalDecisions.length < 60);
	assert.ok(input.context.omitted.globalDecisions > 0);
}

// An over-budget base fails loudly instead of truncating serialized JSON.
assert.throws(() => assembleGlobalInspectionInput({
	globalDecisions: [],
	projects: [],
}, { maxBytes: 8 }));

// Scheduled audits must discover eligible users even before their first
// Consistency page visit creates a global_analysis_states row.
{
	const query = globalInspectionEligibleUsersQuery().toSQL();
	assert.match(query.sql, /from "project_memories"/i);
	assert.match(query.sql, /left join "global_analysis_states"/i);
	assert.match(query.sql, /count\(distinct "project_memories"\."project_id"\) >=/i);
	assert.ok(query.params.includes(MIN_GLOBAL_PROJECTS));
}

console.log("global-inspection: all checks passed");
