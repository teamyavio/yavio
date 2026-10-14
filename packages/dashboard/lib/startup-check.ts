import { requireEraserPassword } from "./clickhouse";

/**
 * Configuration the dashboard cannot run correctly without, checked once when
 * the server starts (instrumentation.ts), so a missing value stops the boot
 * instead of surfacing on first use.
 *
 * The eraser credential is the case that matters (#91): the deletion routes
 * create that client lazily, on the first deletion, inside a catch that logs
 * and still returns 200 — after the Postgres rows are already gone. A missing
 * password there is a silent erasure failure, not an error anyone sees.
 *
 * Exits the process explicitly rather than relying on how Next.js treats an
 * exception thrown from register(). __tests__/startup-check.test.ts starts the
 * built standalone server to prove it.
 */
export async function runStartupChecks(): Promise<void> {
  // `next build` may load the instrumentation hook while prerendering. Build
  // environments (CI, Cloud Build) hold no runtime secrets and must not need them.
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  try {
    requireEraserPassword();
  } catch (err) {
    console.error(`[startup] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // The erasure queue's worker (#91 part 2): retries every queued deletion
  // until each ClickHouse table is done, including requests left over from
  // before a restart. Needs Postgres; a server started without it (as in the
  // standalone boot test) has no queue to work off.
  if (process.env.DATABASE_URL) {
    const { startErasureWorker } = await import("./erasure");
    startErasureWorker();
    // Hourly Postgres housekeeping (#92): login attempts, expired sessions,
    // tokens and invitations, long-revoked API keys.
    const { startHousekeeping } = await import("./housekeeping");
    startHousekeeping();
  }
}
