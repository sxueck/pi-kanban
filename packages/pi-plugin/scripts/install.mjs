import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../dist/pi-kanban.ts", import.meta.url));
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const targetDir = join(agentDir, "extensions");
const target = join(targetDir, "pi-kanban.ts");

if (!existsSync(source)) {
	console.error("dist/pi-kanban.ts not found — run `pnpm build` first");
	process.exit(1);
}
mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);
console.log(`installed: ${target}`);
console.log(`next: create ${join(agentDir, "pi-kanban.json")} (see packages/pi-plugin/README.md), then restart pi or run /reload`);
