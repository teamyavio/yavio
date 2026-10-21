/**
 * `ERASURE_WORKER=off`: the dashboard boots without the eraser credential and
 * never runs a deletion against ClickHouse.
 *
 * For a non-production copy that shares a production ClickHouse: a dev
 * environment seeded from a production Postgres dump carries the production
 * workspace and project ids, so deleting a project there would erase the
 * production tenant's analytics. With the worker off, the delete routes still
 * remove the Postgres rows and queue the erasure request; nothing executes it,
 * and the startup check does not demand CLICKHOUSE_ERASER_PASSWORD, so the
 * copy does not need the production credential at all.
 *
 * Never set this in production: queued erasure requests would never complete,
 * which breaks the deletion promise (#91).
 */
export const ERASURE_WORKER_VARIABLE = "ERASURE_WORKER";

export function erasureWorkerEnabled(): boolean {
  const raw = process.env[ERASURE_WORKER_VARIABLE];
  const value = (raw ?? "on").trim().toLowerCase();
  if (value === "" || value === "on") return true;
  if (value === "off") return false;
  throw new Error(
    `${ERASURE_WORKER_VARIABLE} must be "on" (default) or "off", got "${raw}". "off" is for a non-production copy that shares a production ClickHouse.`,
  );
}

/** The one-line explanation printed at startup when the worker is off. */
export const ERASURE_WORKER_OFF_NOTICE = `[startup] ${ERASURE_WORKER_VARIABLE}=off: deletions are queued in Postgres but never executed against ClickHouse, and CLICKHOUSE_ERASER_PASSWORD is not required. For a non-production copy only.`;
