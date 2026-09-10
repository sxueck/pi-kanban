import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import { MIN_INSPECTION_SESSIONS } from "@pi-kanban/shared";
import { dueInspectionFilter } from "../src/inspector.js";

function queryFor(excludedProjectIds: number[]) {
	const condition = dueInspectionFilter(new Date("2026-01-01T12:00:00Z"), new Date("2026-01-01T11:00:00Z"), excludedProjectIds);
	if (!condition) throw new Error("due-inspection test requires a query condition");
	return new PgDialect().sqlToQuery(condition);
}

// Skipped rows (excluded projects, below the session floor) stay overdue
// forever, so both skip filters must live in the SQL WHERE — post-fetch
// filtering would let them saturate the limit and starve runnable projects.
const query = queryFor([7, 42]);
assert.match(query.sql, /"project_analysis_states"\."next_inspection_at" <=/);
assert.match(query.sql, /"project_analysis_states"\."project_id" not in \(/);
assert.deepEqual(query.params.filter((param) => param === 7 || param === 42), [7, 42]);
assert.match(query.sql, /select count\(\*\) from "sessions"/);
const floor = query.sql.match(/>= \$(\d+)/);
assert.ok(floor, "the session floor must be a SQL condition");
assert.equal(query.params[Number(floor[1]) - 1], MIN_INSPECTION_SESSIONS);

// An empty exclusion list must exclude nothing.
assert.doesNotMatch(queryFor([]).sql, /not in \(/);

console.log("due-inspection-query: all checks passed");
