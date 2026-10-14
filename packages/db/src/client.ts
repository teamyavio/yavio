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

/**
 * Run `fn` while holding a session-level advisory lock, on a connection
 * reserved for just that; null when another session holds the lock.
 *
 * A session lock rather than a transaction lock: the jobs that use it (the
 * statistics job, the erasure worker) hold it across ClickHouse work that can
 * take an hour, and record their progress through `db` as they go, one
 * committed statement each. A crash, a deploy restart or a dropped connection
 * late in the run then keeps what was already done. A transaction held open
 * for the whole run lost all of it — and postgres.js's max_lifetime (30-60
 * min by default) ends an idle pooled connection, transaction or not; a
 * reserved one it leaves alone.
 *
 * Released when `fn` settles, or by Postgres when the connection ends with
 * the process.
 */
export async function withSessionLock<T>(
  db: Database,
  key: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const conn = await db.$client.reserve();
  try {
    const [row] = await conn<
      { locked: boolean }[]
    >`SELECT pg_try_advisory_lock(${key}::bigint) AS locked`;
    if (!row?.locked) return null;
    try {
      return await fn();
    } finally {
      // When the connection died, Postgres has released the lock already and
      // the unlock fails; there is nothing left to do then.
      await conn`SELECT pg_advisory_unlock(${key}::bigint)`.catch(() => {});
    }
  } finally {
    conn.release();
  }
}
