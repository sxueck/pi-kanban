import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString =
	process.env.DATABASE_URL ?? "postgres://pi:pi@localhost:5432/pikanban";

const queryClient = postgres(connectionString, {
	max: 10,
	// Pi sessions are append-mostly; prepared statements interact badly with
	// rapid reconnects in dev, keep them off.
	prepare: false,
});

export const db = drizzle(queryClient, { schema });
export { schema };
