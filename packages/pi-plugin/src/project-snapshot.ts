import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectSnapshotFile, ProjectSnapshotMessage } from "@pi-kanban/shared";

/**
 * Bounded local project-snapshot collection for `project_snapshot` reports.
 *
 * Privacy invariants:
 * - File *names* (relative paths) and sizes only — file contents are never read.
 * - Paths are always relative to the project root and validated (no absolute
 *   paths, no `..` escapes).
 * - Secret-like basenames (.env variants, credentials, private keys) and build/
 *   dependency/VCS directories are never listed.
 * - Every listing is hard-capped (count, depth, path length); `truncated`
 *   reports that the listing is a bounded subset, not the whole project.
 */

// --- bounds -----------------------------------------------------------------

export const MAX_FILES = 2000;
/** Max path segments from the root (root-level file = 1). */
export const MAX_DEPTH = 8;
export const MAX_PATH_CHARS = 500;
export const GIT_TIMEOUT_MS = 2000;
export const GIT_MAX_BUFFER = 1024 * 1024;
export const MAX_GIT_STATUS_LINES = 200;
export const MAX_DIAGNOSTIC_LINES = 100;
/** Hard ceiling on entries examined by the fallback walk (defense in depth). */
export const MAX_SCAN_ENTRIES = 50_000;
/** agent_end refreshes may not run more often than this. */
export const SNAPSHOT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export interface SnapshotLimits {
	maxFiles: number;
	maxDepth: number;
	maxPathChars: number;
}

export const DEFAULT_LIMITS: SnapshotLimits = {
	maxFiles: MAX_FILES,
	maxDepth: MAX_DEPTH,
	maxPathChars: MAX_PATH_CHARS,
};

/** Directories never entered: VCS internals, deps, build output. */
const EXCLUDED_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".next",
	".cache",
	"vendor",
]);

const SECRET_BASENAMES = new Set([
	"credentials",
	".git-credentials",
	"id_rsa",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
]);

const SECRET_SUFFIXES = [".pem", ".key", ".pfx", ".p12", ".keystore", ".jks"];

/** Secret-like *basenames* are filtered wherever they appear in the tree. */
export function isSecretLike(name: string): boolean {
	const lower = name.toLowerCase();
	if (lower === ".env" || lower.startsWith(".env.")) return true;
	if (SECRET_BASENAMES.has(lower)) return true;
	return SECRET_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

// --- git plumbing -------------------------------------------------------------

export interface GitRunOptions {
	/** Accept non-empty stdout when git exits non-zero. Needed for `diff --check`,
	 *  which uses its exit code to signal that findings exist. Off by default:
	 *  other commands print diagnostics to stderr and may echo args to stdout
	 *  (e.g. `rev-parse HEAD` in a repo with no commits). */
	acceptNonZeroExit?: boolean;
}

/** Resolves with stdout, or null when git failed / produced nothing usable. */
export type GitRunner = (
	cwd: string,
	args: string[],
	options?: GitRunOptions,
) => Promise<string | null>;

export function execGit(
	cwd: string,
	args: string[],
	options: GitRunOptions = {},
): Promise<string | null> {
	return new Promise((resolvePromise) => {
		execFile(
			"git",
			args,
			{ cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
			(error, stdout) => {
				if (!error) return resolvePromise(stdout);
				// Distrust stdout when the run was killed (timeout), truncated
				// (maxBuffer) or never started — unless the caller opted into
				// tolerant exits for a command like `diff --check`.
				const usable =
					options.acceptNonZeroExit === true &&
					typeof stdout === "string" &&
					stdout.length > 0 &&
					!error.killed &&
					error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" &&
					error.code !== "ENOENT";
				resolvePromise(usable ? stdout : null);
			},
		);
	});
}

function firstLine(raw: string | null): string | undefined {
	const line = raw?.split("\n")[0]?.trim();
	return line || undefined;
}

/** Remote/branch identity for a project (keys omitted when not a git repo). */
export async function gitIdentity(
	cwd: string,
	git: GitRunner = execGit,
): Promise<{ gitRemote?: string; gitBranch?: string }> {
	const [remote, branch] = await Promise.all([
		git(cwd, ["remote", "get-url", "origin"]),
		git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
	]);
	const identity: { gitRemote?: string; gitBranch?: string } = {};
	const remoteUrl = firstLine(remote);
	if (remoteUrl) identity.gitRemote = remoteUrl;
	const branchName = firstLine(branch);
	if (branchName) identity.gitBranch = branchName;
	return identity;
}

function toLines(raw: string | null, cap: number): string[] {
	if (!raw) return [];
	const lines = raw.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.slice(0, cap);
}

// --- file listing ---------------------------------------------------------------

export interface FileScanResult {
	files: ProjectSnapshotFile[];
	/** True when the listing is a bounded subset of the project. */
	truncated: boolean;
}

export interface CollectFilesOptions {
	git?: GitRunner;
	limits?: Partial<SnapshotLimits>;
}

type PathVerdict = "include" | "skip" | "tooLong" | "tooDeep";

function classifyPath(path: string, limits: SnapshotLimits): PathVerdict {
	const segments = path.split("/");
	if (segments.some((segment) => EXCLUDED_DIRS.has(segment.toLowerCase()))) return "skip";
	if (isSecretLike(segments[segments.length - 1])) return "skip";
	if (segments.length > limits.maxDepth) return "tooDeep";
	if (path.length > limits.maxPathChars) return "tooLong";
	return "include";
}

/** Normalized relative path, or null when the candidate is not acceptable. */
function normalizeGitPath(candidate: string): string | null {
	const path = candidate.replace(/\\/g, "/");
	if (!path || path.startsWith("/") || path.startsWith("~/") || /^[A-Za-z]:/.test(path)) return null;
	const segments = path.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
	return segments.join("/");
}

const byPath = (a: { path: string }, b: { path: string }): number =>
	a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/** Attaches file sizes (best-effort; a vanished file just stays size-less). */
async function attachSizes(root: string, files: ProjectSnapshotFile[]): Promise<void> {
	const CHUNK = 128;
	for (let i = 0; i < files.length; i += CHUNK) {
		await Promise.all(
			files.slice(i, i + CHUNK).map(async (file) => {
				try {
					const stats = await stat(join(root, ...file.path.split("/")));
					if (stats.isFile() && Number.isFinite(stats.size) && stats.size >= 0) {
						file.size = stats.size;
					}
				} catch {
					// The file can vanish between listing and stat; size is optional.
				}
				return undefined;
			}),
		);
	}
}

/** Preferred source: git's own file list (tracked + untracked-not-ignored). */
async function listViaGit(
	root: string,
	git: GitRunner,
	limits: SnapshotLimits,
): Promise<FileScanResult | null> {
	const raw = await git(root, ["ls-files", "-co", "--exclude-standard", "-z"]);
	if (raw === null) return null;
	const candidates = raw
		.split("\0")
		.map((candidate) => normalizeGitPath(candidate))
		.filter((path): path is string => path !== null)
		.sort((left, right) => left.localeCompare(right));
	const files: ProjectSnapshotFile[] = [];
	let truncated = false;
	for (const path of candidates) {
		const verdict = classifyPath(path, limits);
		if (verdict === "skip") continue;
		if (verdict !== "include" || files.length >= limits.maxFiles) {
			truncated = true; // dropped for depth/length/entry cap
			if (files.length >= limits.maxFiles) break;
			continue;
		}
		files.push({ path });
	}
	await attachSizes(root, files);
	return { files, truncated };
}

/** Fallback: bounded directory walk (no git, or git unavailable). */
async function walkFiles(root: string, limits: SnapshotLimits): Promise<FileScanResult> {
	const files: ProjectSnapshotFile[] = [];
	let truncated = false;
	let scanned = 0;
	// Breadth-first, sorted per directory → deterministic output.
	type Dir = { abs: string; segments: string[] };
	const queue: Dir[] = [{ abs: root, segments: [] }];
	while (queue.length > 0) {
		const dir = queue.shift()!;
		let entries;
		try {
			entries = await readdir(dir.abs, { withFileTypes: true });
		} catch {
			truncated = true; // unreadable directory = incomplete listing
			continue;
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			if (++scanned > MAX_SCAN_ENTRIES) {
				truncated = true;
				queue.length = 0;
				break;
			}
			const name = entry.name;
			if (EXCLUDED_DIRS.has(name.toLowerCase()) || isSecretLike(name)) continue;
			// Symlinks (and anything stranger) are skipped: no cycles, no escapes.
			if (!entry.isFile() && !entry.isDirectory()) continue;
			const segments = [...dir.segments, name];
			const path = segments.join("/");
			if (entry.isDirectory()) {
				// Files inside would be one level deeper than maxDepth allows.
				if (segments.length >= limits.maxDepth) {
					truncated = true;
					continue;
				}
				queue.push({ abs: join(dir.abs, name), segments });
				continue;
			}
			const verdict = classifyPath(path, limits);
			if (verdict === "skip") continue;
			if (verdict !== "include" || files.length >= limits.maxFiles) {
				truncated = true;
				continue;
			}
			files.push({ path });
		}
	}
	files.sort(byPath);
	await attachSizes(root, files);
	return { files, truncated };
}

/**
 * Relative-path-only file listing: `git ls-files -co --exclude-standard` when
 * available, otherwise a bounded directory walk. Never reads file contents.
 */
export async function collectFiles(
	root: string,
	options: CollectFilesOptions = {},
): Promise<FileScanResult> {
	const limits: SnapshotLimits = { ...DEFAULT_LIMITS, ...options.limits };
	const git = options.git ?? execGit;
	const viaGit = await listViaGit(root, git, limits);
	if (viaGit) return viaGit;
	return walkFiles(root, limits);
}

// --- hash -----------------------------------------------------------------------

/**
 * Deterministic SHA-256 over the payload-relevant snapshot data (files, git
 * summary, diagnostics, truncated flag) — not timestamps or session metadata.
 */
export function snapshotHash(input: {
	files: ProjectSnapshotFile[];
	git: { head?: string; status: string[] };
	diagnostics: string[];
	truncated: boolean;
}): string {
	const canonical = JSON.stringify({
		files: input.files.map((file) => [file.path, file.size ?? null]),
		git: { head: input.git.head ?? null, status: input.git.status },
		diagnostics: input.diagnostics,
		truncated: input.truncated,
	});
	return createHash("sha256").update(canonical).digest("hex");
}

// --- orchestration ---------------------------------------------------------------

export interface SnapshotCollectOptions extends CollectFilesOptions {
	sessionId: string;
	cwd: string;
	gitRemote?: string;
	gitBranch?: string;
	/** Injectable clock (defaults to Date.now). */
	now?: number;
}

export async function collectProjectSnapshot(
	options: SnapshotCollectOptions,
): Promise<ProjectSnapshotMessage> {
	const git = options.git ?? execGit;
	const limits = options.limits;
	const cwd = options.cwd;
	const [scan, head, status, diffCheck] = await Promise.all([
		collectFiles(cwd, { git, limits }),
		git(cwd, ["rev-parse", "HEAD"]),
		git(cwd, ["status", "--short", "--branch", "--untracked-files=no"]),
		git(cwd, ["diff", "--check"], { acceptNonZeroExit: true }),
	]);
	const partial = {
		files: scan.files,
		git: { head: firstLine(head), status: toLines(status, MAX_GIT_STATUS_LINES) },
		diagnostics: toLines(diffCheck, MAX_DIAGNOSTIC_LINES),
		truncated: scan.truncated,
	};
	return {
		type: "project_snapshot",
		sessionId: options.sessionId,
		cwd,
		gitRemote: options.gitRemote,
		gitBranch: options.gitBranch,
		...partial,
		hash: snapshotHash(partial),
		createdAt: options.now ?? Date.now(),
	};
}

/**
 * Refresh cadence + change detection for agent_end snapshots:
 * - isDue(): at most one refresh per SNAPSHOT_REFRESH_INTERVAL_MS;
 * - observe(): records a completed refresh; true when the hash is new and the
 *   snapshot should be sent.
 */
export class SnapshotThrottle {
	private lastHash: string | null = null;
	private lastRefreshAt = Number.NEGATIVE_INFINITY;

	constructor(private readonly minIntervalMs: number = SNAPSHOT_REFRESH_INTERVAL_MS) {}

	/** Reset per session so change detection never leaks across sessions. */
	reset(): void {
		this.lastHash = null;
		this.lastRefreshAt = Number.NEGATIVE_INFINITY;
	}

	isDue(now: number): boolean {
		return now - this.lastRefreshAt >= this.minIntervalMs;
	}

	/** Marks the refresh as done (even when the hash is unchanged). */
	observe(hash: string, now: number): boolean {
		this.lastRefreshAt = now;
		if (hash === this.lastHash) return false;
		this.lastHash = hash;
		return true;
	}

	/** A failed attempt still consumed the cadence budget. */
	markRefreshed(now: number): void {
		this.lastRefreshAt = now;
	}
}
