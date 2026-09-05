import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProjectSnapshotMessage } from "@pi-kanban/shared";
import {
	collectFiles,
	collectProjectSnapshot,
	gitIdentity,
	MAX_DIAGNOSTIC_LINES,
	MAX_FILES,
	MAX_GIT_STATUS_LINES,
	snapshotHash,
	SnapshotThrottle,
	type GitRunner,
} from "../src/project-snapshot.js";

// --- fixtures ------------------------------------------------------------------

const NO_GIT: GitRunner = async () => null;

async function withTempTree(build: (dir: string) => Promise<void>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-kanban-snap-"));
	try {
		await build(dir);
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
	return dir;
}

async function touch(root: string, relPath: string, content = "x"): Promise<void> {
	const abs = join(root, relPath);
	await mkdir(dirname(abs), { recursive: true });
	await writeFile(abs, content);
}

function assertRelativePaths(snapshot: ProjectSnapshotMessage): void {
	for (const file of snapshot.files) {
		assert.ok(!file.path.includes("\\"), `backslash in path: ${file.path}`);
		assert.ok(!file.path.startsWith("/"), `absolute path: ${file.path}`);
		assert.ok(!file.path.split("/").includes(".."), `.. escape: ${file.path}`);
		assert.ok(file.path.length <= 500, `path too long: ${file.path}`);
	}
}

let gitAvailable = true;
try {
	execFileSync("git", ["--version"]);
} catch {
	gitAvailable = false;
}

// --- tests ---------------------------------------------------------------------

const tests: Array<[string, () => Promise<void>]> = [
	[
		"walk fallback: junk dirs and secret-like basenames are excluded, sizes kept",
		async () => {
			const dir = await withTempTree(async (root) => {
				await touch(root, "README.md", "hello"); // 5 bytes
				await touch(root, "src/index.ts", "export {};\n");
				await touch(root, ".env", "A=1");
				await touch(root, ".env.local", "A=1");
				await touch(root, ".env.production", "A=1");
				await touch(root, "credentials", "x");
				await touch(root, "keys/id_rsa", "x");
				await touch(root, "keys/id_ed25519", "x");
				await touch(root, "certs/server.pem", "x");
				await touch(root, "certs/app.key", "x");
				await touch(root, "node_modules/pkg/index.js");
				await touch(root, "dist/out.js");
				await touch(root, "build/out.js");
				await touch(root, "coverage/lcov.info");
				await touch(root, ".next/x.js");
				await touch(root, ".cache/y.js");
				await touch(root, "vendor/lib.js");
				await touch(root, ".git/HEAD");
			});
			try {
				const scan = await collectFiles(dir, { git: NO_GIT });
				assert.deepEqual(
					scan.files.map((f) => f.path).sort(),
					["README.md", "src/index.ts"],
				);
				assert.equal(scan.truncated, false);
				const readme = scan.files.find((f) => f.path === "README.md");
				assert.equal(readme?.size, 5);
				assertRelativePaths({ files: scan.files } as ProjectSnapshotMessage);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	],
	[
		"walk fallback: depth cap drops deeper files and flags truncation",
		async () => {
			const dir = await withTempTree(async (root) => {
				await touch(root, "root.txt");
				// 8 path segments = exactly maxDepth → kept
				await touch(root, "a/b/c/d/e/f/g/ok.txt");
				// 9 path segments → dropped
				await touch(root, "a/b/c/d/e/f/g/h/deep.txt");
			});
			try {
				const scan = await collectFiles(dir, { git: NO_GIT });
				assert.deepEqual(scan.files.map((f) => f.path), [
					"a/b/c/d/e/f/g/ok.txt",
					"root.txt",
				]);
				assert.equal(scan.truncated, true);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	],
	[
		"walk fallback: entry cap keeps the first maxFiles in sorted order",
		async () => {
			const dir = await withTempTree(async (root) => {
				for (let i = 0; i < 5; i++) await touch(root, `f${i}.txt`);
			});
			try {
				const scan = await collectFiles(dir, { git: NO_GIT, limits: { maxFiles: 2 } });
				assert.deepEqual(scan.files.map((f) => f.path), ["f0.txt", "f1.txt"]);
				assert.equal(scan.truncated, true);
				// Deterministic: same tree, same listing.
				const again = await collectFiles(dir, { git: NO_GIT, limits: { maxFiles: 2 } });
				assert.deepEqual(again, scan);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	],
	[
		"walk fallback: over-long relative paths are dropped and flagged",
		async () => {
			const dir = await withTempTree(async (root) => {
				await touch(root, "ok.txt");
				await touch(root, "way-too-long-file-name.txt");
			});
			try {
				const scan = await collectFiles(dir, { git: NO_GIT, limits: { maxPathChars: 10 } });
				assert.deepEqual(scan.files.map((f) => f.path), ["ok.txt"]);
				assert.equal(scan.truncated, true);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	],
	[
		"git ls-files wins over the walk; untracked secrets filtered, sizes attached",
		async () => {
			const dir = await withTempTree(async (root) => {
				await touch(root, "tracked.ts", "y"); // 1 byte
				await touch(root, ".env.local", "SECRET=1");
				// virtual/tracked.ts exists only in the git index — never on disk.
			});
			const calls: string[][] = [];
			const git: GitRunner = async (_cwd, args) => {
				calls.push(args);
				if (args[0] === "ls-files") {
					return ["tracked.ts", "virtual/tracked.ts", "node_modules/pkg.js", ".env.local"].join("\0");
				}
				return null;
			};
			try {
				const scan = await collectFiles(dir, { git });
				assert.deepEqual(calls, [["ls-files", "-co", "--exclude-standard", "-z"]]);
				assert.deepEqual(scan.files, [
					{ path: "tracked.ts", size: 1 },
					{ path: "virtual/tracked.ts" }, // index-only: no size available
				]);
				assert.equal(scan.truncated, false);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	],
	[
		"git listing is hard-capped at 2000 files with truncation flagged",
		async () => {
			const dir = await withTempTree(async () => {});
			const names = Array.from({ length: MAX_FILES + 100 }, (_, i) => `f${String(i).padStart(5, "0")}.txt`);
			const git: GitRunner = async (_cwd, args) =>
				args[0] === "ls-files" ? names.join("\0") : null;
			try {
				const scan = await collectFiles(dir, { git });
				assert.equal(scan.files.length, MAX_FILES);
				assert.equal(scan.truncated, true);
				assert.equal(scan.files[0]?.path, "f00000.txt");
				assert.ok(scan.files.every((f, i) => i === 0 || f.path > scan.files[i - 1]!.path));
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	],
	[
		"git summary and diagnostics are capped (200 status lines, 100 diff-check lines)",
		async () => {
			const git: GitRunner = async (_cwd, args) => {
				if (args[0] === "rev-parse") return "5fakedeadbeef5\n";
				if (args[0] === "status") {
					assert.deepEqual(args, ["status", "--short", "--branch", "--untracked-files=no"]);
					return Array.from({ length: 250 }, (_, i) => `M src/file${i}.ts`).join("\n");
				}
				if (args[0] === "diff") {
					assert.deepEqual(args, ["diff", "--check"]);
					return Array.from({ length: 130 }, (_, i) => `src/file${i}.ts:1: trailing whitespace.`).join("\n");
				}
				if (args[0] === "ls-files") return "a.ts\0";
				return null;
			};
			const dir = await withTempTree(async () => {});
			try {
				const snapshot = await collectProjectSnapshot({
					sessionId: "s1",
					cwd: dir,
					git,
					now: 1000,
				});
				assert.equal(snapshot.git.head, "5fakedeadbeef5");
				assert.equal(snapshot.git.status.length, MAX_GIT_STATUS_LINES);
				assert.equal(snapshot.git.status[0], "M src/file0.ts");
				assert.equal(snapshot.diagnostics.length, MAX_DIAGNOSTIC_LINES);
				assert.equal(snapshot.truncated, false);
				assert.equal(snapshot.hash, snapshotHash(snapshot));
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	],
	[
		"snapshot never includes file contents — paths and sizes only",
		async () => {
			const MARKER = "TOPSECRET-CONTENT-MARKER-42";
			const dir = await withTempTree(async (root) => {
				await touch(root, "src/app.ts", `const x = "${MARKER}";\n`);
			});
			try {
				const snapshot = await collectProjectSnapshot({ sessionId: "s1", cwd: dir, git: NO_GIT });
				const raw = JSON.stringify(snapshot);
				assert.ok(!raw.includes(MARKER), "file content leaked into the snapshot");
				assertRelativePaths(snapshot);
				for (const file of snapshot.files) {
					assert.ok(
						Object.keys(file).every((key) => key === "path" || key === "size"),
						`unexpected field on file entry: ${Object.keys(file).join(",")}`,
					);
				}
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	],
	[
		"hash is deterministic over files/git/diagnostics/truncated, not time",
		async () => {
			const dir = await withTempTree(async (root) => {
				await touch(root, "a.txt", "one");
			});
			try {
				const first = await collectProjectSnapshot({ sessionId: "s1", cwd: dir, git: NO_GIT, now: 1000 });
				const second = await collectProjectSnapshot({ sessionId: "s1", cwd: dir, git: NO_GIT, now: 999_999 });
				assert.equal(first.hash, second.hash);
				assert.notEqual(first.createdAt, second.createdAt);
				assert.match(first.hash, /^[0-9a-f]{64}$/);

				// Any payload-relevant change must move the hash…
				await writeFile(join(dir, "a.txt"), "one!");
				const changedSize = await collectProjectSnapshot({ sessionId: "s1", cwd: dir, git: NO_GIT, now: 1000 });
				assert.notEqual(changedSize.hash, first.hash);
				// …including the truncated flag.
				const truncated = await collectProjectSnapshot({
					sessionId: "s1",
					cwd: dir,
					git: NO_GIT,
					now: 1000,
					limits: { maxFiles: 0 },
				});
				assert.equal(truncated.files.length, 0);
				assert.equal(truncated.truncated, true);
				assert.notEqual(truncated.hash, changedSize.hash);

				// Direct helper: stable and content-sensitive.
				const base = { files: [{ path: "a" }], git: { status: [] as string[] }, diagnostics: [] as string[], truncated: false };
				assert.equal(snapshotHash(base), snapshotHash(base));
				assert.notEqual(
					snapshotHash(base),
					snapshotHash({ ...base, files: [{ path: "a", size: 3 }] }),
				);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	],
	[
		"SnapshotThrottle: ≤1 refresh per window, send only on hash change",
		async () => {
			const throttle = new SnapshotThrottle(1000);
			assert.equal(throttle.isDue(0), true);
			assert.equal(throttle.observe("h1", 0), true); // first snapshot sends
			assert.equal(throttle.isDue(500), false); // inside the budget
			assert.equal(throttle.observe("h1", 500), false); // unchanged → no send, budget booked
			assert.equal(throttle.isDue(600), false);
			assert.equal(throttle.isDue(1000), false); // budget booked at 500 runs until 1500
			assert.equal(throttle.isDue(1500), true); // budget elapsed
			assert.equal(throttle.observe("h1", 1500), false); // due but unchanged → still no send
			assert.equal(throttle.observe("h2", 1500), true); // changed → send
			throttle.reset();
			assert.equal(throttle.observe("h2", 2000), true); // new session: baseline reset
		},
	],
	[
		"gitIdentity resolves remote/branch and degrades to undefined",
		async () => {
			const present = await gitIdentity("/proj", async (_cwd, args) =>
				args[0] === "remote" ? "https://example.com/repo.git\n" : "feature/agent\n",
			);
			assert.deepEqual(present, {
				gitRemote: "https://example.com/repo.git",
				gitBranch: "feature/agent",
			});
			const absent = await gitIdentity("/proj", async () => null);
			assert.deepEqual(absent, {});
		},
	],
	[
		"integration: real git repo — ls-files preferred, .env filtered, diff --check findings kept",
		async () => {
			if (!gitAvailable) {
				console.log("     (git not on PATH — skipped)");
				return;
			}
			const dir = await withTempTree(async (root) => {
				execFileSync("git", ["init", "-q"], { cwd: root });
				await touch(root, "alpha-unique.ts", "export const a = 1;\n");
				await touch(root, "sub/beta-unique.ts", "b");
				await touch(root, ".env", "SECRET=1");
			});
			try {
				const fresh = await collectProjectSnapshot({
					sessionId: "s-git",
					cwd: dir,
					now: 42,
				});
				assert.equal(fresh.type, "project_snapshot");
				assert.equal(fresh.sessionId, "s-git");
				assert.ok(fresh.files.some((f) => f.path === "alpha-unique.ts"));
				assert.ok(fresh.files.some((f) => f.path === "sub/beta-unique.ts"));
				assert.ok(!fresh.files.some((f) => f.path.startsWith(".env")));
				assert.equal(fresh.git.head, undefined); // no commits yet (rev-parse echoes "HEAD" to stdout on failure — must be ignored)
				assert.ok(fresh.git.status.length >= 1); // --short --branch header
				assert.deepEqual(fresh.diagnostics, []);
				assert.equal(fresh.gitRemote, undefined);
				assert.equal(fresh.truncated, false);
				assertRelativePaths(fresh);

				// Commit (self-contained identity), then dirty the worktree with a
				// trailing-whitespace line: `git diff --check` now exits non-zero
				// WITH stdout — diagnostics must survive exactly that case.
				execFileSync("git", ["add", "."], { cwd: dir });
				execFileSync(
					"git",
					["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"],
					{ cwd: dir },
				);
				await writeFile(join(dir, "alpha-unique.ts"), "export const a = 1;\nconst b = 2;   \n");
				const dirty = await collectProjectSnapshot({ sessionId: "s-git", cwd: dir, now: 43 });
				assert.ok(dirty.git.head && /^[0-9a-f]{40}$/.test(dirty.git.head));
				assert.ok(dirty.git.status.some((line) => line.includes("alpha-unique.ts")));
				assert.ok(
					dirty.diagnostics.some((line) => line.includes("alpha-unique.ts")),
					`expected diff --check findings, got: ${JSON.stringify(dirty.diagnostics)}`,
					);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	],
];

// --- harness --------------------------------------------------------------------

let failed = 0;
for (const [name, body] of tests) {
	try {
		await body();
		console.log(`ok - ${name}`);
	} catch (error) {
		failed++;
		console.error(`FAIL - ${name}`);
		console.error(error);
	}
}
if (failed > 0) process.exit(1);
console.log(`\n${tests.length - failed}/${tests.length} passed`);
