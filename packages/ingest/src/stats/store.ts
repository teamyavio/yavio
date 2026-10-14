import type { Database } from "@yavio/db/client";
import { projects, statsJobRuns } from "@yavio/db/schema";
import { eq, sql } from "drizzle-orm";

/** Postgres side of the statistics job: lock, run state, existing projects. */
export interface StatsJobSession {
  /** Ids of the projects that exist; deleted projects are skipped. */
  listProjectIds(): Promise<string[]>;
  getLastSuccess(job: string): Promise<Date | null>;
  recordSuccess(job: string, at: Date): Promise<void>;
  recordFailure(job: string, at: Date, error: string): Promise<void>;
}

export interface StatsJobStore {
  /**
   * Run `fn` while holding the job's lock; null if another ingest instance
   * holds it (that instance does the run).
   */
  withLock<T>(fn: (session: StatsJobSession) => Promise<T>): Promise<T | null>;
}

/** Arbitrary but fixed key for pg_try_advisory_xact_lock. */
export const STATS_JOB_LOCK_KEY = 8_502_311_985;

/**
 * Postgres store. The lock is a transaction-level advisory lock, so it is
 * released when the transaction ends — also when the process dies mid-run —
 * and the run state is written in the same transaction.
 */
export class PgStatsJobStore implements StatsJobStore {
  constructor(private readonly db: Database) {}

  async withLock<T>(fn: (session: StatsJobSession) => Promise<T>): Promise<T | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${STATS_JOB_LOCK_KEY}) AS locked`,
      );
      if (!row?.locked) return null;

      const session: StatsJobSession = {
        listProjectIds: async () =>
          (await tx.select({ id: projects.id }).from(projects)).map((p) => p.id),
        getLastSuccess: async (job) => {
          const [state] = await tx
            .select({ lastSuccessAt: statsJobRuns.lastSuccessAt })
            .from(statsJobRuns)
            .where(eq(statsJobRuns.job, job));
          return state?.lastSuccessAt ?? null;
        },
        recordSuccess: async (job, at) => {
          await tx
            .insert(statsJobRuns)
            .values({ job, lastSuccessAt: at, lastAttemptAt: at, lastError: null })
            .onConflictDoUpdate({
              target: statsJobRuns.job,
              set: { lastSuccessAt: at, lastAttemptAt: at, lastError: null },
            });
        },
        recordFailure: async (job, at, error) => {
          await tx
            .insert(statsJobRuns)
            .values({ job, lastAttemptAt: at, lastError: error })
            .onConflictDoUpdate({
              target: statsJobRuns.job,
              set: { lastAttemptAt: at, lastError: error },
            });
        },
      };
      return fn(session);
    });
  }
}
