import { sql } from "drizzle-orm";
import type { Database } from "./client.js";

/**
 * Execute a callback within a transaction that has RLS context set.
 * Sets `app.current_user_id` as a session-local variable, scoped to
 * the transaction. This enables PostgreSQL row-level security policies
 * to filter rows automatically.
 *
 * Must be called with a Drizzle client connected as `yavio_app` role
 * (which has RLS enforced). The `yavio_service` role bypasses RLS.
 *
 * See: .specs/infrastructure/storage-layer.md §5.2.13
 */
export async function withRLS<T>(
  db: Database,
  userId: string,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
    return fn(tx as unknown as Database);
  });
}
