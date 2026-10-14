import type { ClickHouseClient } from "@clickhouse/client";
import { platformValues } from "@yavio/shared/platform";
import { monthsToProcess, partitionId, ranToday, utcDay } from "./months.js";
import { addMonths } from "./months.js";
import {
  EARLIEST_MONTH,
  VOCAB_MIN_INDIVIDUALS,
  VOCAB_TOP_N,
  statsCohortsInsert,
  statsDailyInsert,
  statsUsersDailyInsert,
  statsUsersPeriodsInsert,
} from "./queries.js";
import type { StatsJobSession, StatsJobStore } from "./store.js";

/** The stats tables, each with the INSERT that fills its stage for one month. */
export const STATS_TABLES: ReadonlyArray<{ table: string; insert: (stage: string) => string }> = [
  { table: "stats_daily", insert: statsDailyInsert },
  { table: "stats_users_daily", insert: statsUsersDailyInsert },
  { table: "stats_users_periods", insert: statsUsersPeriodsInsert },
  { table: "stats_cohorts", insert: statsCohortsInsert },
];

interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface StatsJobOptions {
  /** ClickHouse as yavio_rollup. */
  clickhouse: ClickHouseClient;
  store: StatsJobStore;
  logger: Logger;
  /** How often to check whether today's run is due (default 1 h). */
  checkIntervalMs?: number;
  /** Delay of the first check after start (default 1 min). */
  initialDelayMs?: number;
}

export interface TableReport {
  table: string;
  months: string[];
  status: "done" | "skipped" | "failed";
  error?: string;
}

/** Outcome of one run; null means another instance held the lock. */
export type RunReport = { tables: TableReport[] } | null;

/**
 * The anonymous-statistics job (#85, step 3).
 *
 * Once a day (UTC), under a Postgres advisory lock so only one ingest instance
 * runs it, every stats table is recomputed for the previous and the current
 * month, plus every month since its last successful run (backfill on the
 * first run). Per month and table:
 *   1. TRUNCATE the stage table;
 *   2. INSERT into the stage from events FINAL, LIMIT 1 BY event_id;
 *   3. ALTER TABLE ... REPLACE PARTITION <month> FROM the stage.
 * That is atomic and idempotent: a failed or repeated run leaves either the
 * old or the new month, never a mix. Projects that no longer exist in
 * Postgres are skipped, so the job cannot resurrect deleted data.
 */
export class StatsJob {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<RunReport> | null = null;

  constructor(private readonly options: StatsJobOptions) {}

  start(): void {
    const { checkIntervalMs = 60 * 60 * 1000, initialDelayMs = 60 * 1000 } = this.options;
    const tick = () => {
      this.runIfDue().catch((err) =>
        this.options.logger.error({ err }, "Statistics job failed to run"),
      );
    };
    this.startTimer = setTimeout(tick, initialDelayMs);
    this.timer = setInterval(tick, checkIntervalMs);
  }

  stop(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.timer) clearInterval(this.timer);
    this.startTimer = null;
    this.timer = null;
  }

  /** Run every table whose statistics have not run today. Never overlaps itself. */
  async runIfDue(now: Date = new Date()): Promise<RunReport> {
    if (this.running) return this.running;
    this.running = this.options.store.withLock((session) => this.run(session, now));
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }

  private async run(session: StatsJobSession, now: Date): Promise<{ tables: TableReport[] }> {
    const { logger } = this.options;
    const projects = await session.listProjectIds();
    if (projects.length === 0) {
      // Nothing to compute — and replacing partitions with an empty result
      // would erase statistics, so do not mark anything as done.
      return {
        tables: STATS_TABLES.map((t) => ({ table: t.table, months: [], status: "skipped" })),
      };
    }
    const earliest = await this.earliestMonth(projects);
    const tables: TableReport[] = [];

    for (const { table, insert } of STATS_TABLES) {
      const lastSuccess = await session.getLastSuccess(table);
      if (ranToday(lastSuccess, now)) {
        tables.push({ table, months: [], status: "skipped" });
        continue;
      }
      const months = monthsToProcess(lastSuccess, now, earliest);
      try {
        for (const month of months) await this.rollupMonth(table, insert, month, projects, now);
        await session.recordSuccess(table, now);
        tables.push({ table, months, status: "done" });
        logger.info({ table, months }, "Statistics computed");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await session.recordFailure(table, now, message.slice(0, 2_000));
        tables.push({ table, months, status: "failed", error: message });
        logger.error({ table, months, err }, "Statistics job failed for a table");
      }
    }
    return { tables };
  }

  private async rollupMonth(
    table: string,
    insert: (stage: string) => string,
    month: string,
    projects: string[],
    now: Date,
  ): Promise<void> {
    const ch = this.options.clickhouse;
    const stage = `${table}_stage`;
    await ch.command({ query: `TRUNCATE TABLE ${stage}` });
    await ch.command({
      query: insert(stage),
      query_params: {
        projects,
        platforms: [...platformValues],
        vocabMinIndividuals: VOCAB_MIN_INDIVIDUALS,
        vocabTopN: VOCAB_TOP_N,
        monthStart: month,
        nextMonthStart: addMonths(month, 1),
        today: utcDay(now),
      },
      clickhouse_settings: { async_insert: 0 },
    });
    await ch.command({
      query: `ALTER TABLE ${table} REPLACE PARTITION ${partitionId(month)} FROM ${stage}`,
      // ClickHouse 26.x refuses REPLACE PARTITION from an empty source, as a
      // guard against silently dropping data. Here an empty stage means the
      // month has no events for any existing project, so its statistics ARE
      // empty — e.g. after the last project with data in it was deleted.
      // Only months whose raw data still exists are ever recomputed.
      clickhouse_settings: { allow_replace_partition_from_empty_source: 1 },
    });
  }

  private async earliestMonth(projects: string[]): Promise<string | null> {
    const result = await this.options.clickhouse.query({
      query: EARLIEST_MONTH,
      query_params: { projects },
      format: "JSONEachRow",
    });
    const [row] = await result.json<{ month: string; n: string | number }>();
    return row && Number(row.n) > 0 ? row.month : null;
  }
}
