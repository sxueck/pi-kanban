import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { PluginConfig } from "@pi-kanban/shared";

export const PLUGIN_VERSION = "0.1.0";

/** Resolved lazily so tests (and tools) can point the plugin at a scratch dir. */
function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** Defaults mirror the user's local workflow-guard patterns plus cloud-remote risks. */
const DEFAULT_RULES = [
	{ tool: "bash", match: "rm\\s+(-[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)", flags: "i", label: "rm -rf" },
	{ tool: "bash", match: "\\bgit\\s+push\\b", flags: "i", label: "git push" },
	{ tool: "bash", match: "\\bgit\\s+reset\\s+--hard\\b", flags: "i", label: "git reset --hard" },
	{ tool: "bash", match: "\\bgit\\s+clean\\b[^\\n]*(-f|--force)", flags: "i", label: "git clean -f" },
	{ tool: "bash", match: "\\bsudo\\b", flags: "i", label: "sudo" },
	{ tool: "bash", match: "curl[^|;]*\\|\\s*(ba)?sh", flags: "i", label: "curl | sh" },
	// Interactive tools park the session until a human answers; gate them
	// through the same cloud approval so nothing wedges invisibly. Both known
	// ask-user tool names are listed (name varies across pi versions).
	{ tool: "ask_user", label: "ask user", interactive: true },
	{ tool: "ask_user_question", label: "ask user", interactive: true },
];

function defaultConfig(): PluginConfig {
	return {
		server: {
			url: "ws://localhost:8787/agent",
		},
		gate: {
			rules: DEFAULT_RULES,
			localTimeoutSec: 30,
			cloudTimeoutSec: 300,
			onTimeout: "deny",
			escalateWhenHeadless: true,
		},
		report: {
			excerptChars: 2000,
			reportToolInputs: true,
		},
	};
}

/**
 * Accepts a base URL (`https://host[:port]`, `host:port`) or a full ws
 * endpoint (`ws://host/agent`); upgrades http(s) to ws(s) and appends the
 * `/agent` endpoint when no path was given.
 */
export function normalizeServerUrl(raw: string): string {
	const value = raw.trim();
	try {
		const url = new URL(value.includes("://") ? value : `ws://${value}`);
		if (url.protocol === "http:") url.protocol = "ws:";
		else if (url.protocol === "https:") url.protocol = "wss:";
		if (url.pathname === "" || url.pathname === "/") url.pathname = "/agent";
		return url.toString();
	} catch {
		return value;
	}
}

export function loadConfig(): PluginConfig {
	const configPath = join(agentDir(), "pi-kanban.json");
	const config = defaultConfig();
	if (existsSync(configPath)) {
		try {
			const raw = JSON.parse(readFileSync(configPath, "utf8")) as Partial<PluginConfig>;
			if (raw.server) {
				// Migration: tokens were once kept in the config file; they are env-only now.
				if ("agentToken" in raw.server) {
					delete (raw.server as { agentToken?: unknown }).agentToken;
					console.error(`[pi-kanban] server.agentToken in ${configPath} is ignored — set the PI_KANBAN_TOKEN environment variable instead`);
				}
				Object.assign(config.server, raw.server);
			}
			if (raw.gate) Object.assign(config.gate, raw.gate);
			if (raw.report) Object.assign(config.report, raw.report);
		} catch (error) {
			console.error(`[pi-kanban] invalid config at ${configPath}:`, error);
		}
	}
	// Env wins over the config file — documented as an environment override.
	const envUrl = process.env.PI_KANBAN_URL?.trim();
	if (envUrl) config.server.url = envUrl;
	config.server.url = normalizeServerUrl(config.server.url);
	return config;
}

/** Machine agent token — env-only by design so it never lands in a dotfile. */
export function agentToken(): string {
	return process.env.PI_KANBAN_TOKEN ?? "";
}

/** Stable per-machine identity (survives reinstalls, unique per device). */
export function machineId(): string {
	const machineIdPath = join(agentDir(), "pi-kanban-machine-id");
	try {
		if (existsSync(machineIdPath)) {
			const id = readFileSync(machineIdPath, "utf8").trim();
			if (id) return id;
		}
		const id = randomUUID();
		mkdirSync(agentDir(), { recursive: true });
		writeFileSync(machineIdPath, id);
		return id;
	} catch {
		return `unknown-${hostname()}`;
	}
}
