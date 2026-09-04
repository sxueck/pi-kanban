import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const source = new URL("../dist/pi-kanban.ts", import.meta.url).pathname;
const targetDir = join(homedir(), ".pi", "agent", "extensions");
const target = join(targetDir, "pi-kanban.ts");

if (!existsSync(source)) {
	console.error("dist/pi-kanban.ts not found — run `pnpm build` first");
	process.exit(1);
}
mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);
console.log(`installed: ${target}`);
console.log("next: create ~/.pi/agent/pi-kanban.json (see packages/pi-plugin/README.md), then restart pi or run /reload");
