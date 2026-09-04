import { serve } from "@hono/node-server";
import { api } from "./api.js";
import { agentWss, handleUpgrade } from "./ws.js";
import { sweepExpiredApprovals, sweepOfflineSessions } from "./approvals.js";

const port = Number(process.env.PORT ?? 8787);

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
}, SWEEP_INTERVAL_MS);
sweeper.unref();

function shutdown() {
	console.log("[pi-kanban] shutting down");
	clearInterval(sweeper);
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 3_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
