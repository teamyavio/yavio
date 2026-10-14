import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import { erasureRequests } from "@yavio/db/schema";
import { asc, eq, isNull, sql } from "drizzle-orm";

type Request = typeof erasureRequests.$inferSelect;

/**
 * The ClickHouse tables a tenant's data lives in, and how to select it.
 * tool_registry has no workspace_id, so it is erased by the projects
 * snapshotted with the request. users_mv / sessions_mv go away with #89;
 * once they no longer exist they count as done.
 */
export const ERASURE_TABLES: ReadonlyArray<{
  table: string;
  byProjectOnly?: boolean;
  mayNotExist?: boolean;
}> = [
  { table: "events" },
  { table: "tool_registry", byProjectOnly: true },
  { table: "stats_daily" },
  { table: "stats_users_daily" },
  { table: "stats_users_periods" },
  { table: "stats_cohorts" },
  { table: "users_mv", mayNotExist: true },
  { table: "sessions_mv", mayNotExist: true },
];

/** Requests still pending after this long are reported as an error. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Arbitrary but fixed key, distinct from the statistics job's. */
export const ERASURE_LOCK_KEY = 8_502_311_986;

interface Logger {
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ErasureWorkerOptions {
  db: Database;
  /** As yavio_eraser: ALTER DELETE on the tables above, nothing else. */
  clickhouse: () => ClickHouseClient;
  logger?: Logger;
  intervalMs?: number;
  now?: () => Date;
}

export interface ErasureRunReport {
  pending: number;
  completed: number;
  failed: number;
  stale: number;
}

function isUnknownTable(err: unknown): boolean {
  const e = err as { code?: string; type?: string; message?: string };
  return e?.code === "60" || e?.type === "UNKNOWN_TABLE" || /UNKNOWN_TABLE/.test(e?.message ?? "");
}

function deleteStatement(
  table: string,
  byProjectOnly: boolean,
  request: Request,
): { query: string; params: Record<string, unknown> } | null {
  if (request.scope === "workspace" && !byProjectOnly) {
    return {
      query: `ALTER TABLE ${table} DELETE WHERE workspace_id = {workspaceId:String} SETTINGS mutations_sync = 1`,
      params: { workspaceId: request.workspaceId },
    };
  }
  if (request.projectIds.length === 0) return null; // a workspace without projects
  return {
    query: `ALTER TABLE ${table} DELETE WHERE project_id IN {projectIds:Array(String)} SETTINGS mutations_sync = 1`,
    params: { projectIds: request.projectIds },
  };
}

/**
 * Works off erasure_requests (#91 part 2): for each pending request, delete
 * the tenant's rows from every table in ERASURE_TABLES, remembering which are
 * done, until all are. Runs every minute, and right after a deletion; under a
 * Postgres advisory lock, so several dashboard instances never duplicate the
 * work. A request pending for more than 24 h is logged as an error on every
 * run until it completes.
 */
export class ErasureWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<ErasureRunReport | null> | null = null;
  private again = false;

  constructor(private readonly options: ErasureWorkerOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.kick(), this.options.intervalMs ?? 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Process now (e.g. right after a deletion); never runs twice at once. */
  kick(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.processPending()
      .catch((err) => this.options.logger?.error("[erasure] worker run failed", err))
      .finally(() => {
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  async processPending(): Promise<ErasureRunReport | null> {
    if (this.running) return this.running;
    this.running = this.run();
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }

  private async run(): Promise<ErasureRunReport | null> {
    const { db, logger } = this.options;
    const now = this.options.now ?? (() => new Date());

    return db.transaction(async (tx) => {
      const [lock] = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${ERASURE_LOCK_KEY}) AS locked`,
      );
      if (!lock?.locked) return null;

      const pending = await tx
        .select()
        .from(erasureRequests)
        .where(isNull(erasureRequests.completedAt))
        .orderBy(asc(erasureRequests.requestedAt))
        .limit(100);

      const report: ErasureRunReport = {
        pending: pending.length,
        completed: 0,
        failed: 0,
        stale: 0,
      };
      for (const request of pending) {
        const done = new Set(request.tablesDone);
        let error: string | null = null;

        for (const { table, byProjectOnly = false, mayNotExist = false } of ERASURE_TABLES) {
          if (done.has(table)) continue;
          const statement = deleteStatement(table, byProjectOnly, request);
          try {
            if (statement) {
              await this.options
                .clickhouse()
                .command({ query: statement.query, query_params: statement.params });
            }
            done.add(table);
          } catch (err) {
            if (mayNotExist && isUnknownTable(err)) {
              done.add(table);
              continue;
            }
            error = `${table}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 2_000);
            break; // retry this request on the next run
          }
        }

        const completed = ERASURE_TABLES.every((t) => done.has(t.table));
        const at = now();
        await tx
          .update(erasureRequests)
          .set({
            tablesDone: [...done],
            attempts: request.attempts + 1,
            lastAttemptAt: at,
            lastError: error,
            completedAt: completed ? at : null,
          })
          .where(eq(erasureRequests.id, request.id));

        if (completed) {
          report.completed++;
          logger?.info(`[erasure] ${request.scope} ${request.workspaceId} erased`);
        } else {
          report.failed++;
          const age = at.getTime() - request.requestedAt.getTime();
          if (age > STALE_AFTER_MS) {
            report.stale++;
            logger?.error(
              `[erasure] request ${request.id} (${request.scope} ${request.workspaceId}) pending for ${Math.round(age / 3_600_000)} h — ClickHouse data not erased: ${error}`,
            );
          } else {
            logger?.error(`[erasure] request ${request.id} not done yet, will retry: ${error}`);
          }
        }
      }
      return report;
    });
  }
}
