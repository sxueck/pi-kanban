import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { PluginConfig } from "@pi-kanban/shared";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "pi-kanban.json");
const MACHINE_ID_PATH = join(AGENT_DIR, "pi-kanban-machine-id");

export const PLUGIN_VERSION = "0.1.0";

/** Defaults mirror the user's local workflow-guard patterns plus cloud-remote risks. */
const DEFAULT_RULES = [
	{ tool: "bash", match: "rm\\s+(-[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)", flags: "i", label: "rm -rf" },
	{ tool: "bash", match: "\\bgit\\s+push\\b", flags: "i", label: "git push" },
	{ tool: "bash", match: "\\bgit\\s+reset\\s+--hard\\b", flags: "i", label: "git reset --hard" },
	{ tool: "bash", match: "\\bgit\\s+clean\\b[^\\n]*(-f|--force)", flags: "i", label: "git clean -f" },
	{ tool: "bash", match: "\\bsudo\\b", flags: "i", label: "sudo" },
	{ tool: "bash", match: "curl[^|;]*\\|\\s*(ba)?sh", flags: "i", label: "curl | sh" },
];

function defaultConfig(): PluginConfig {
	return {
		server: {
			url: process.env.PI_KANBAN_URL ?? "ws://localhost:8787/agent",
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

export function loadConfig(): PluginConfig {
	const config = defaultConfig();
	if (existsSync(CONFIG_PATH)) {
		try {
			const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<PluginConfig>;
			if (raw.server) {
				// Migration: tokens were once kept in the config file; they are env-only now.
				if ("agentToken" in raw.server) {
					delete (raw.server as { agentToken?: unknown }).agentToken;
					console.error(`[pi-kanban] server.agentToken in ${CONFIG_PATH} is ignored — set the PI_KANBAN_TOKEN environment variable instead`);
				}
				Object.assign(config.server, raw.server);
			}
			if (raw.gate) Object.assign(config.gate, raw.gate);
			if (raw.report) Object.assign(config.report, raw.report);
		} catch (error) {
			console.error(`[pi-kanban] invalid config at ${CONFIG_PATH}:`, error);
		}
	}
	return config;
}

/** Machine agent token — env-only by design so it never lands in a dotfile. */
export function agentToken(): string {
	return process.env.PI_KANBAN_TOKEN ?? "";
}

/** Stable per-machine identity (survives reinstalls, unique per device). */
export function machineId(): string {
	try {
		if (existsSync(MACHINE_ID_PATH)) {
			const id = readFileSync(MACHINE_ID_PATH, "utf8").trim();
			if (id) return id;
		}
		const id = randomUUID();
		mkdirSync(AGENT_DIR, { recursive: true });
		writeFileSync(MACHINE_ID_PATH, id);
		return id;
	} catch {
		return `unknown-${hostname()}`;
	}
}
