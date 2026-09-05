import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, normalizeServerUrl } from "../src/config.js";

// Base URLs are upgraded to ws(s) and get the /agent endpoint appended.
assert.equal(normalizeServerUrl("https://kanban.example.com"), "wss://kanban.example.com/agent");
assert.equal(normalizeServerUrl("http://host:8787"), "ws://host:8787/agent");
assert.equal(normalizeServerUrl("host:8787"), "ws://host:8787/agent");
assert.equal(normalizeServerUrl("  wss://host/agent  "), "wss://host/agent");
// An explicit path (reverse-proxy subpath) is kept as-is.
assert.equal(normalizeServerUrl("https://host/kanban/agent"), "wss://host/kanban/agent");

// PI_KANBAN_URL must override the config file's server.url, not just default it.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pikb-cfg-"));
writeFileSync(
	join(process.env.PI_CODING_AGENT_DIR, "pi-kanban.json"),
	JSON.stringify({ server: { url: "ws://from-file:1/agent" } }),
);
delete process.env.PI_KANBAN_URL;
assert.equal(loadConfig().server.url, "ws://from-file:1/agent");

process.env.PI_KANBAN_URL = "https://from-env:9";
assert.equal(loadConfig().server.url, "wss://from-env:9/agent");

delete process.env.PI_KANBAN_URL;
delete process.env.PI_CODING_AGENT_DIR;

console.log("config: all checks passed");
