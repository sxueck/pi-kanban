import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { api } from "./api.js";
import { runMigrations } from "./migrate.js";
import { agentWss, handleUpgrade } from "./ws.js";
import { sweepExpiredApprovals, sweepOfflineSessions } from "./approvals.js";
import { cleanEmptyUuidSessions, runDueInspections } from "./inspector.js";

const rootEnvFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env");
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

const port = Number(process.env.PORT ?? 8787);

try {
	await runMigrations();
} catch (error) {
	console.error("[pi-kanban] migration failed:", error instanceof Error ? error.message : error);
	process.exit(1);
}

const server = serve({ fetch: api.fetch, port }, (info) => {
	console.log(`[pi-kanban] api+ws listening on http://localhost:${info.port}`);
	console.log(`[pi-kanban] plugin ws endpoint: ws://localhost:${info.port}/agent`);
});

server.on("upgrade", (req, socket, head) => {
	const { pathname } = new URL(req.url ?? "/", `http://${req.headers.host}`);
	if (pathname === "/agent") {
		agentWss.handleUpgrade(req, socket, head, (ws) => handleUpgrade(ws));
	} else {
		socket.destroy();
	}
});

const SWEEP_INTERVAL_MS = 30_000;
const sweeper = setInterval(() => {
	void sweepExpiredApprovals();
	void sweepOfflineSessions();
	void runDueInspections().catch((error) => {
		console.error("[pi-kanban] inspection sweep failed:", error instanceof Error ? error.message : error);
	});
}, SWEEP_INTERVAL_MS);
sweeper.unref();

// Untitled placeholder sessions are swept hourly on their own cadence, not
// only when an inspection happens to be queued.
const UNTITLED_SESSION_SWEEP_MS = 60 * 60_000;
const untitledSweeper = setInterval(() => void cleanEmptyUuidSessions(), UNTITLED_SESSION_SWEEP_MS);
untitledSweeper.unref();
// Boot-time pass so rows that went stale while the server was down do not
// wait a full interval.
void cleanEmptyUuidSessions();

function shutdown() {
	console.log("[pi-kanban] shutting down");
	clearInterval(sweeper);
	clearInterval(untitledSweeper);
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 3_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
