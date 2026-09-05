import assert from "node:assert/strict";
import { hashPassword, hashToken, newSecret, validatePassword, validateUsername, verifyPassword } from "../src/auth.js";

assert.equal(validateUsername("alice.dev"), true);
assert.equal(validateUsername("ab"), false);
assert.equal(validateUsername("alice smith"), false);
assert.equal(validatePassword("long-enough-password"), true);
assert.equal(validatePassword("short"), false);

const password = "correct horse battery staple";
const encoded = await hashPassword(password);
assert.notEqual(encoded, password);
assert.equal(await verifyPassword(password, encoded), true);
assert.equal(await verifyPassword("wrong password", encoded), false);
assert.equal(await verifyPassword(password, "invalid"), false);

const first = newSecret();
const second = newSecret();
assert.notEqual(first, second);
assert.equal(hashToken(first), hashToken(first));
assert.notEqual(hashToken(first), hashToken(second));

console.log("auth: all checks passed");
