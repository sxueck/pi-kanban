import type { ProjectSnapshotFile, ProjectTreeNodeDTO } from "@pi-kanban/shared";

const MAX_STRUCTURE_NODES = 250;
const MAX_DERIVED_FILES = 2_000;
const MAX_DEPTH = 5;
const FILE_READ_TOOLS = new Set(["read", "read_symbol", "read_enclosing"]);
/** Tools whose path input names a real project file (read or written). */
const FILE_TOUCH_TOOLS = new Set([...FILE_READ_TOOLS, "edit", "write"]);

export interface ProjectToolCall {
	cwd: string;
	toolName: string;
	input: unknown;
}

export interface ProjectReadCoverage {
	tree: ProjectTreeNodeDTO[];
	totalFiles: number;
	readFiles: number;
}

export function buildStructureTree(
	files: ProjectSnapshotFile[],
	projectName: string,
): ProjectTreeNodeDTO[] {
	const nodes: ProjectTreeNodeDTO[] = [{ id: "project", kind: "project", label: projectName }];
	const counts = new Map<string, number>();
	const rootFiles: string[] = [];

	for (const file of files) {
		const parts = normalizePath(file.path).split("/").filter(Boolean);
		if (parts.length === 1) rootFiles.push(parts[0]);
		for (let depth = 1; depth < Math.min(parts.length, MAX_DEPTH + 1); depth++) {
			const dir = parts.slice(0, depth).join("/");
			counts.set(dir, (counts.get(dir) ?? 0) + 1);
		}
	}

	const directories = [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
	for (const [dir, count] of directories) {
		if (nodes.length >= MAX_STRUCTURE_NODES) break;
		const slash = dir.lastIndexOf("/");
		const parentPath = slash < 0 ? "" : dir.slice(0, slash);
		nodes.push({
			id: `path:${dir}`,
			parentId: parentPath ? `path:${parentPath}` : "project",
			kind: "module",
			label: slash < 0 ? dir : dir.slice(slash + 1),
			fileCount: count,
		});
	}

	for (const file of rootFiles.sort((left, right) => left.localeCompare(right))) {
		if (nodes.length >= MAX_STRUCTURE_NODES) break;
		nodes.push({ id: `file:${file}`, parentId: "project", kind: "file", label: file });
	}
	return nodes;
}

/** Overlay actual session read-tool paths onto the snapshot-backed project structure. */
export function addProjectReadCoverage(
	tree: ProjectTreeNodeDTO[],
	files: ProjectSnapshotFile[],
	toolCalls: ProjectToolCall[],
): ProjectReadCoverage {
	const paths = [...new Set(files.map((file) => normalizePath(file.path)).filter(Boolean))];
	const knownPaths = new Set(paths);
	const readPaths = new Set<string>();
	for (const call of toolCalls) {
		if (!isFileReadTool(call.toolName)) continue;
		const path = readPathFromInput(call.input, call.cwd);
		if (path && knownPaths.has(path)) readPaths.add(path);
	}
	const coverageFor = (id: string): { totalFiles: number; readFiles: number } | undefined => {
		const prefix = coveragePrefix(id);
		if (prefix === undefined) return undefined;
		const matching = prefix ? paths.filter((path) => path === prefix || path.startsWith(prefix)) : paths;
		return { totalFiles: matching.length, readFiles: matching.filter((path) => readPaths.has(path)).length };
	};
	return {
		tree: tree.map((node) => {
			const coverage = coverageFor(node.id);
			return coverage ? { ...node, coverage } : node;
		}),
		totalFiles: paths.length,
		readFiles: readPaths.size,
	};
}

const INSIGHT_KINDS = new Set<ProjectTreeNodeDTO["kind"]>(["decision", "milestone", "issue", "evidence"]);

/**
 * Tree stored when a new snapshot arrives: fresh structure plus the insight
 * nodes merged by the last inspection. Without this, every snapshot upload
 * would wipe inspection insights from latestTree until the next run.
 */
export function mergeSnapshotTree(
	existingTree: unknown,
	files: ProjectSnapshotFile[],
	projectName: string,
): ProjectTreeNodeDTO[] {
	const insights = Array.isArray(existingTree)
		? existingTree.filter((node): node is ProjectTreeNodeDTO =>
				Boolean(node) && typeof node === "object" &&
				INSIGHT_KINDS.has((node as ProjectTreeNodeDTO).kind) &&
				typeof (node as ProjectTreeNodeDTO).id === "string" &&
				typeof (node as ProjectTreeNodeDTO).label === "string")
		: [];
	return mergeProjectTree(buildStructureTree(files, projectName), insights);
}

export function mergeProjectTree(
	structure: ProjectTreeNodeDTO[],
	insights: ProjectTreeNodeDTO[],
): ProjectTreeNodeDTO[] {
	const ids = new Set(structure.map((node) => node.id));
	return [
		...structure,
		...insights.map((node) => ({
			...node,
			parentId: node.parentId && ids.has(node.parentId) ? node.parentId : "project",
		})),
	].slice(0, MAX_STRUCTURE_NODES + 300);
}

/**
 * Snapshot substitute for projects that never uploaded one: file paths the
 * sessions actually read or wrote. Lets the structure tree and read coverage
 * work before the first plugin snapshot arrives.
 */
export function collectToolCallFiles(toolCalls: ProjectToolCall[]): ProjectSnapshotFile[] {
	const paths = new Set<string>();
	for (const call of toolCalls) {
		if (!FILE_TOUCH_TOOLS.has(call.toolName.split(/[.:]/).at(-1) ?? "")) continue;
		const path = readPathFromInput(call.input, call.cwd);
		if (path) paths.add(path);
	}
	return [...paths].sort().slice(0, MAX_DERIVED_FILES).map((path) => ({ path }));
}

function coveragePrefix(id: string): string | undefined {
	if (id === "project") return "";
	if (id.startsWith("path:")) return `${id.slice(5)}/`;
	if (id.startsWith("file:")) return id.slice(5);
	return undefined;
}

function isFileReadTool(toolName: string): boolean {
	return FILE_READ_TOOLS.has(toolName.split(/[.:]/).at(-1) ?? "");
}

function readPathFromInput(input: unknown, cwd: string): string | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const path = (input as { path?: unknown }).path;
	if (typeof path !== "string") return undefined;
	const normalized = normalizePath(path);
	const root = normalizePath(cwd).replace(/\/$/, "");
	if (root && normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
	return normalized.startsWith("/") || /^[a-z]:\//i.test(normalized) ? undefined : normalized;
}

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}
