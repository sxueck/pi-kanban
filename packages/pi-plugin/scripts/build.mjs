import { build } from "esbuild";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

await build({
	entryPoints: ["src/index.ts"],
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	outfile: "dist/pi-kanban.js",
	legalComments: "none",
});

renameSync("dist/pi-kanban.js", "dist/pi-kanban.ts");
const path = "dist/pi-kanban.ts";
const bundled = readFileSync(path, "utf8");
const annotated = bundled.replace(
	"const res = await fetch(this.heartbeatUrl, {",
	"// pi-lens-ignore: ts-ssrf\n      const res = await fetch(this.heartbeatUrl, {",
);
if (annotated === bundled) throw new Error("could not annotate HTTP heartbeat fetch");
writeFileSync(path, annotated);
