import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

/**
 * Create a Drizzle ORM client connected to PostgreSQL.
 * Uses the postgres.js driver for Node.js.
 */
export function createDb(url: string) {
  const sql = postgres(url);
  return drizzle(sql, { schema });
}

export type Database = ReturnType<typeof createDb>;
