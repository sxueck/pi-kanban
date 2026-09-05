import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import { boardSessionFilter } from "../src/api.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const condition = boardSessionFilter(USER_ID);
if (!condition) throw new Error("board-query test requires a query condition");
const query = new PgDialect().sqlToQuery(condition);

assert.match(query.sql, /"sessions"\."user_id" = \$\d+/);
assert.match(query.sql, /"sessions"\."state" in \(\$\d+, \$\d+, \$\d+, \$\d+\)/);

// The board must only surface sessions whose task started: turn_count > 0
// must filter out merely-opened (untitled, no-prompt) sessions.
const turnCount = query.sql.match(/"sessions"\."turn_count" > \$(\d+)/);
assert.ok(turnCount, "board filter must require turn_count > 0");
assert.equal(query.params[Number(turnCount[1]) - 1], 0);
assert.equal(query.params.includes(USER_ID), true);
assert.equal(query.params.some(Array.isArray), false);

console.log("board-query: all checks passed");
