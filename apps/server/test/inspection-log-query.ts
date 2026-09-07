import assert from "node:assert/strict";
import { inspectionLogListQuery } from "../src/api.js";

const query = inspectionLogListQuery("11111111-1111-1111-1111-111111111111", 1).toSQL();

// Failed runs can lack a transcript row entirely (e.g. the model request
// never went out); the history must still list them, so the transcript
// join must be a LEFT JOIN rooted at project_inspections.
assert.match(query.sql, /from "project_inspections"/i);
assert.match(query.sql, /left join "project_inspection_logs"/i);
assert.ok(!/inner join "project_inspection_logs"/i.test(query.sql));

console.log("inspection-log-query: all checks passed");
