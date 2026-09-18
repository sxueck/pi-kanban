import assert from "node:assert/strict";
import { redactForModel, redactText } from "../src/redact.js";

// ISO dates share the phone shape (digits + hyphens) and must survive redaction.
{
	const result = redactText("as of 2026-09-15 the migration failed; verified on 2026-09-14 and 2026-09-15");
	assert.equal(result.count, 0);
	assert.ok(result.value.includes("2026-09-15"));
}
assert.equal(redactText("timestamp 2026-09-15T11:29:00Z ok").count, 0);

// Phone-shaped digit runs are still redacted.
{
	const result = redactText("call +1 (425) 555-1234 or 425-555-1234 or 4255551234");
	assert.equal(result.count, 3);
	assert.ok(!result.value.includes("425"));
}

// A run that only starts like a date (extra digits past the YYYY-MM-DD shape) stays phone-shaped.
assert.match(redactText("dial 2026-091-5555 now").value, /\[REDACTED:phone\]/);

// redactForModel walks nested structures and leaves non-strings alone.
{
	const result = redactForModel({ a: "as of 2026-09-15", b: ["call 4255551234"], c: { d: 7, e: null } });
	assert.equal(result.count, 1);
	assert.equal(result.value.a, "as of 2026-09-15");
	assert.match(result.value.b[0], /\[REDACTED:phone\]/);
	assert.equal(result.value.c.d, 7);
	assert.equal(result.value.c.e, null);
}

console.log("redact: all checks passed");
