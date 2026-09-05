import type { ProjectSnapshotFile, ProjectTreeNodeDTO } from "@pi-kanban/shared";

const MAX_STRUCTURE_NODES = 250;
const MAX_DEPTH = 5;

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
			detail: `${count} file${count === 1 ? "" : "s"}`,
		});
	}

	for (const file of rootFiles.sort((left, right) => left.localeCompare(right))) {
		if (nodes.length >= MAX_STRUCTURE_NODES) break;
		nodes.push({ id: `file:${file}`, parentId: "project", kind: "module", label: file });
	}
	return nodes;
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

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}
