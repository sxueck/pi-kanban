import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/**
 * Boot-time SQL migrations from apps/server/drizzle, applied in filename
 * order on a dedicated single connection under an advisory lock, so
 * concurrent container starts cannot race. Databases first created with
 * `pnpm db:push` (drizzle-kit syncs schema.ts directly and keeps no ledger)
 * are detected via an existing core table and baselined instead of replayed.
 */
export async function runMigrations(): Promise<void> {
	// Same default as src/db/index.ts.
	const client = postgres(process.env.DATABASE_URL ?? "postgres://pi:pi@localhost:5432/pikanban", {
		max: 1,
		prepare: false,
	});
	try {
		const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
		const files = readdirSync(dir)
			.filter((f) => f.endsWith(".sql"))
			// drizzle-kit numbers files with a fixed 4-digit prefix, so lexical
			// order equals application order.
			.sort((a, b) => a.localeCompare(b));

		await client.unsafe("select pg_advisory_lock(hashtext('pi-kanban-migrations'))");
		await client.unsafe("create table if not exists _migrations (filename text primary key, applied_at timestamptz not null default now())");
		const applied = new Set<string>(
			(await client.unsafe<{ filename: string }[]>("select filename from _migrations")).map((row) => row.filename),
		);

		if (applied.size === 0 && files.length > 0 && await schemaExists(client)) {
			for (const file of files) await client.unsafe("insert into _migrations (filename) values ($1)", [file]);
			return;
		}

		for (const file of files) {
			if (applied.has(file)) continue;
			const statements = readFileSync(path.join(dir, file), "utf8")
				.split("--> statement-breakpoint")
				.map((s) => s.trim())
				.filter(Boolean);
			await client.begin(async (tx) => {
				for (const statement of statements) await tx.unsafe(statement);
				await tx.unsafe("insert into _migrations (filename) values ($1)", [file]);
			});
		}
	} finally {
		// Closing the connection also releases the advisory lock.
		await client.end();
	}
}

async function schemaExists(client: postgres.Sql): Promise<boolean> {
	const rows = await client.unsafe<{ reg: string | null }[]>("select to_regclass('public.users') as reg");
	return rows[0]?.reg != null;
}
