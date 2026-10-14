import { type Database, withSessionLock } from "@yavio/db/client";
import { projects, statsJobRuns } from "@yavio/db/schema";
import { eq } from "drizzle-orm";

/** Postgres side of the statistics job: lock, run state, existing projects. */
export interface ProjectRetention {
  id: string;
  /** Months of raw events this project keeps (#93): 2-13, 13 = the platform window. */
  retentionMonths: number;
}

export interface StatsJobSession {
  /** The projects that exist (deleted ones are skipped), with their retention. */
  listProjects(): Promise<ProjectRetention[]>;
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

/** Arbitrary but fixed key for pg_try_advisory_lock. */
export const STATS_JOB_LOCK_KEY = 8_502_311_985;

/**
 * Postgres store. The lock is a session-level advisory lock on a reserved
 * connection (withSessionLock), released when the run ends — also when the
 * process dies mid-run. The run state is written outside it, one committed
 * statement per record: a table marked done stays done when the run fails or
 * the process restarts later on, so a backfill resumes where it stopped
 * instead of starting over.
 */
export class PgStatsJobStore implements StatsJobStore {
  constructor(private readonly db: Database) {}

  async withLock<T>(fn: (session: StatsJobSession) => Promise<T>): Promise<T | null> {
    const { db } = this;
    const session: StatsJobSession = {
      listProjects: async () =>
        db.select({ id: projects.id, retentionMonths: projects.retentionMonths }).from(projects),
      getLastSuccess: async (job) => {
        const [state] = await db
          .select({ lastSuccessAt: statsJobRuns.lastSuccessAt })
          .from(statsJobRuns)
          .where(eq(statsJobRuns.job, job));
        return state?.lastSuccessAt ?? null;
      },
      recordSuccess: async (job, at) => {
        await db
          .insert(statsJobRuns)
          .values({ job, lastSuccessAt: at, lastAttemptAt: at, lastError: null })
          .onConflictDoUpdate({
            target: statsJobRuns.job,
            set: { lastSuccessAt: at, lastAttemptAt: at, lastError: null },
          });
      },
      recordFailure: async (job, at, error) => {
        await db
          .insert(statsJobRuns)
          .values({ job, lastAttemptAt: at, lastError: error })
          .onConflictDoUpdate({
            target: statsJobRuns.job,
            set: { lastAttemptAt: at, lastError: error },
          });
      },
    };
    return withSessionLock(db, STATS_JOB_LOCK_KEY, () => fn(session));
  }
}
