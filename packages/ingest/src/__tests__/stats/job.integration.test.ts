import { randomUUID } from "node:crypto";
import { type ClickHouseClient, type ClickHouseSettings, createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { StatsJob } from "../../stats/job.js";
import type { StatsJobSession, StatsJobStore } from "../../stats/store.js";
import { disconnect, getClient, runMigrations } from "../integration/helpers/clickhouse-setup.js";

// #85 step 3 against a real ClickHouse, as the job's own user yavio_rollup —
// so this also proves migration 0015 grants it enough, and nothing reads
// data through the superuser.

const NOW = new Date("2026-10-14T03:00:00Z");
const ROLLUP_PASSWORD = "rollup-test";
const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** In-memory run state; the Postgres store has its own test. */
class MemoryStore implements StatsJobStore {
  lastSuccess = new Map<string, Date>();
  failures = new Map<string, string>();
  locked = false;
  retention = new Map<string, number>();
  constructor(public projects: string[]) {}
  async withLock<T>(fn: (s: StatsJobSession) => Promise<T>): Promise<T | null> {
    if (this.locked) return null;
    return fn({
      listProjects: async () =>
        this.projects.map((id) => ({ id, retentionMonths: this.retention.get(id) ?? 13 })),
      getLastSuccess: async (job) => this.lastSuccess.get(job) ?? null,
      recordSuccess: async (job, at) => {
        this.lastSuccess.set(job, at);
      },
      recordFailure: async (job, _at, error) => {
        this.failures.set(job, error);
      },
    });
  }
}

let rollup: ClickHouseClient;

function event(project: string, timestamp: string, o: Record<string, unknown> = {}) {
  return {
    event_id: randomUUID(),
    workspace_id: `ws-${project}`,
    project_id: project,
    trace_id: "t",
    session_id: "s-default",
    event_type: "tool_call",
    event_name: "search",
    timestamp,
    source: "server",
    ...o,
  };
}

async function insert(rows: object[], settings: ClickHouseSettings = {}) {
  await getClient().insert({
    table: "events",
    values: rows,
    format: "JSONEachRow",
    clickhouse_settings: settings,
  });
}

async function rows(query: string, params: Record<string, unknown>) {
  const r = await getClient().query({ query, query_params: params, format: "JSONEachRow" });
  return r.json<Record<string, unknown>>();
}

function job(store: StatsJobStore) {
  return new StatsJob({ clickhouse: rollup, store, logger: silent });
}

describe("statistics job (#85)", () => {
  beforeAll(async () => {
    await runMigrations();
    await getClient().command({
      query: `ALTER USER yavio_rollup IDENTIFIED BY '${ROLLUP_PASSWORD}'`,
    });
    const url = new URL(process.env.CLICKHOUSE_URL ?? "http://localhost:8123");
    url.username = "yavio_rollup";
    url.password = ROLLUP_PASSWORD;
    rollup = createClient({ url: url.toString() });
  });

  afterAll(async () => {
    await rollup?.close();
    await disconnect();
  });

  let project: string;
  beforeEach(() => {
    project = `p-${randomUUID().slice(0, 8)}`;
  });

  it("backfills every month that still has events on the first run, as yavio_rollup", async () => {
    await insert([
      event(project, "2026-08-05 10:00:00.000"),
      event(project, "2026-09-05 10:00:00.000"),
      event(project, "2026-10-05 10:00:00.000"),
    ]);
    const store = new MemoryStore([project]);
    const report = await job(store).runIfDue(NOW);

    expect(report?.tables.every((t) => t.status === "done")).toBe(true);
    expect(report?.tables[0].months).toEqual(["2026-08-01", "2026-09-01", "2026-10-01"]);
    const totals = await rows(
      "SELECT toString(day) AS day, events FROM stats_daily WHERE project_id = {p:String} AND slice = 'total' ORDER BY day",
      { p: project },
    );
    expect(totals.map((r) => [r.day, Number(r.events)])).toEqual([
      ["2026-08-05", 1],
      ["2026-09-05", 1],
      ["2026-10-05", 1],
    ]);
  });

  it("is idempotent: running a month twice gives identical partitions", async () => {
    await insert([
      event(project, "2026-10-02 10:00:00.000", { user_id: "u1" }),
      event(project, "2026-10-03 10:00:00.000", {
        user_id: "u2",
        event_type: "conversion",
        event_name: "buy",
        conversion_value: 5,
        conversion_currency: "EUR",
      }),
    ]);
    const snapshot = async () =>
      JSON.stringify(
        await rows("SELECT * FROM stats_daily WHERE project_id = {p:String} ORDER BY ALL", {
          p: project,
        }),
      );
    const store = new MemoryStore([project]);
    await job(store).runIfDue(NOW);
    const first = await snapshot();
    store.lastSuccess.clear(); // force a second run the same day
    await job(store).runIfDue(NOW);
    expect(await snapshot()).toBe(first);
  });

  it("counts a batch that was stored twice once", async () => {
    const batch = [
      event(project, "2026-10-02 10:00:00.000"),
      event(project, "2026-10-02 11:00:00.000"),
    ];
    // events is a ReplacingMergeTree: a background merge between the inserts
    // and the count below would collapse the copies and fail the precondition
    // (seen in a full-suite run). Merges stay off until the count.
    await getClient().command({ query: "SYSTEM STOP MERGES events" });
    let raw: Record<string, unknown>[];
    try {
      await insert(batch);
      // Stored a second time, past insert deduplication (as before #90).
      await insert(batch, { insert_deduplicate: 0 });
      raw = await rows("SELECT count() AS n FROM events WHERE project_id = {p:String}", {
        p: project,
      });
    } finally {
      await getClient().command({ query: "SYSTEM START MERGES events" });
    }
    expect(Number(raw[0].n)).toBe(4);

    await job(new MemoryStore([project])).runIfDue(NOW);
    const total = await rows(
      "SELECT sum(events) AS n FROM stats_daily WHERE project_id = {p:String} AND slice = 'total'",
      { p: project },
    );
    expect(Number(total[0].n)).toBe(2);
  });

  it("counts the same event stored with two timestamps once (a clamped SDK resend)", async () => {
    const id = randomUUID();
    await insert([
      event(project, "2026-10-02 10:00:00.000", { event_id: id }),
      event(project, "2026-10-02 10:07:00.000", { event_id: id }),
    ]);
    await job(new MemoryStore([project])).runIfDue(NOW);
    const total = await rows(
      "SELECT sum(events) AS n FROM stats_daily WHERE project_id = {p:String} AND slice = 'total'",
      { p: project },
    );
    expect(Number(total[0].n)).toBe(1);
  });

  it("catches up every month since the last success, and does not run twice a day", async () => {
    await insert([
      event(project, "2026-08-20 10:00:00.000"),
      event(project, "2026-10-01 10:00:00.000"),
    ]);
    const store = new MemoryStore([project]);
    for (const t of ["stats_daily", "stats_users_daily", "stats_users_periods", "stats_cohorts"]) {
      store.lastSuccess.set(t, new Date("2026-08-10T03:00:00Z"));
    }
    const first = await job(store).runIfDue(NOW);
    expect(first?.tables[0]).toMatchObject({
      status: "done",
      months: ["2026-08-01", "2026-09-01", "2026-10-01"],
    });

    // A restart later the same day: the state says it already ran.
    const again = await job(store).runIfDue(new Date("2026-10-14T21:00:00Z"));
    expect(again?.tables.every((t) => t.status === "skipped")).toBe(true);
  });

  it("does nothing while another instance holds the lock", async () => {
    const store = new MemoryStore([project]);
    store.locked = true;
    expect(await job(store).runIfDue(NOW)).toBeNull();
  });

  it("counts users by one key: stitched user_id, else subject_id, never an empty user_id", async () => {
    await insert([
      // One person before and after identify(): counted once.
      event(project, "2026-10-02 09:00:00.000", { subject_id: "subA", session_id: "s1" }),
      event(project, "2026-10-02 09:05:00.000", {
        subject_id: "subA",
        user_id: "anna",
        session_id: "s1",
      }),
      event(project, "2026-10-02 09:10:00.000", { user_id: "anna", session_id: "s2" }),
      // Someone the app never identifies, known by subject_id.
      event(project, "2026-10-02 10:00:00.000", { subject_id: "subB", session_id: "s3" }),
      // Empty user_id and no subject: not a person.
      event(project, "2026-10-02 11:00:00.000", { user_id: "", session_id: "s4" }),
    ]);
    await job(new MemoryStore([project])).runIfDue(NOW);

    const stats = await rows(
      "SELECT dau FROM stats_users_daily WHERE project_id = {p:String} AND day = '2026-10-02'",
      { p: project },
    );
    // Tier 1 (#89's key, straight from events) must agree with tier 2.
    const tier1 = await rows(
      `WITH stitch AS (
         SELECT subject_id, argMax(user_id, timestamp) AS uid FROM events
         WHERE project_id = {p:String} AND subject_id != '' AND user_id != ''
         GROUP BY subject_id)
       SELECT uniqExact(coalesce(nullIf(e.user_id, ''), nullIf(s.uid, ''), nullIf(e.subject_id, ''))) AS dau
       FROM events AS e LEFT JOIN stitch AS s ON s.subject_id = ifNull(e.subject_id, '')
       WHERE e.project_id = {p:String} AND toDate(e.timestamp) = '2026-10-02'`,
      { p: project },
    );
    expect(Number(stats[0].dau)).toBe(2);
    expect(Number(tier1[0].dau)).toBe(2);

    // individuals in stats_daily falls back to the session for nobody-cells:
    // anna, subB and the unidentified session s4.
    const total = await rows(
      "SELECT individuals FROM stats_daily WHERE project_id = {p:String} AND slice = 'total'",
      { p: project },
    );
    expect(Number(total[0].individuals)).toBe(3);
  });

  it("writes no period or cohort that begins before the first stored event", async () => {
    // What the raw data cannot support must not be frozen as final. After the
    // TTL grew from 90 days to 13 months (0013), the first backfill saw a few
    // months of events — yet Q3 and the year begin long before them, and a
    // month is never recomputed once its raw data is gone.
    const user = (id: string, ts: string) => event(project, ts, { user_id: id });
    await insert([
      user("u1", "2026-07-16 10:00:00.000"), // the earliest event still stored
      user("u1", "2026-08-05 10:00:00.000"),
      user("u2", "2026-08-20 10:00:00.000"),
      user("u3", "2026-09-10 10:00:00.000"),
    ]);
    await job(new MemoryStore([project])).runIfDue(NOW);

    const periods = await rows(
      `SELECT period, toString(period_start) AS start, users FROM stats_users_periods
       WHERE project_id = {p:String} AND period != 'week' ORDER BY period, start`,
      { p: project },
    );
    // Not July and not Q3 (both begin before July 16); Q4 and 2026 are still open.
    expect(periods.map((r) => [r.period, r.start, Number(r.users)])).toEqual([
      ["month", "2026-08-01", 2],
      ["month", "2026-09-01", 1],
    ]);

    const cohorts = await rows(
      `SELECT toString(cohort_month) AS cohort, toString(activity_month) AS month, users
       FROM stats_cohorts WHERE project_id = {p:String} ORDER BY month, cohort`,
      { p: project },
    );
    // u1's July cohort is left out: first seen in the month the data starts
    // in, so possibly seen before it. u2 (August) and u3 (September) count.
    expect(cohorts.map((r) => [r.cohort, r.month, Number(r.users)])).toEqual([
      ["2026-08-01", "2026-08-01", 1],
      ["2026-09-01", "2026-09-01", 1],
    ]);
  });

  it("admits only registered tools and common names into event_name; the rest is '(other)'", async () => {
    await getClient().insert({
      table: "tool_registry",
      values: [
        {
          project_id: project,
          tool_name: "search",
          registered_at: "2026-10-01 00:00:00.000",
          updated_at: "2026-10-01 00:00:00.000",
        },
      ],
      format: "JSONEachRow",
    });
    const common = Array.from({ length: 5 }, (_, i) =>
      event(project, "2026-10-02 12:00:00.000", {
        event_type: "track",
        event_name: "checkout_started",
        user_id: `u${i}`,
      }),
    );
    await insert([
      event(project, "2026-10-02 10:00:00.000", { user_id: "solo" }), // registered tool, 1 person
      event(project, "2026-10-02 11:00:00.000", {
        event_type: "track",
        event_name: "note jane doe 1999",
        user_id: "solo",
      }),
      ...common,
    ]);
    await job(new MemoryStore([project])).runIfDue(NOW);

    const names = await rows(
      "SELECT DISTINCT event_name FROM stats_daily WHERE project_id = {p:String} AND slice = 'tool' ORDER BY event_name",
      { p: project },
    );
    expect(names.map((r) => r.event_name)).toEqual(["(other)", "checkout_started", "search"]);
  });

  it("skips projects that no longer exist in Postgres, and drops their recomputed months", async () => {
    const deleted = `p-gone-${randomUUID().slice(0, 8)}`;
    await insert([
      event(project, "2026-10-02 10:00:00.000"),
      event(deleted, "2026-10-02 10:00:00.000"),
    ]);
    await job(new MemoryStore([project, deleted])).runIfDue(NOW);
    const before = await rows(
      "SELECT count() AS n FROM stats_daily WHERE project_id = {p:String}",
      { p: deleted },
    );
    expect(Number(before[0].n)).toBeGreaterThan(0);

    // The project is deleted in Postgres; the next run must not keep or recreate it.
    await job(new MemoryStore([project])).runIfDue(new Date("2026-10-15T03:00:00Z"));
    const after = await rows("SELECT count() AS n FROM stats_daily WHERE project_id = {p:String}", {
      p: deleted,
    });
    expect(Number(after[0].n)).toBe(0);
  });

  it("counts connection rows as distinct sessions: one per session, however many processes reported it (#142)", async () => {
    // Two instances of a stateless fleet served one conversation: each
    // emitted its own connection event (random id, own timestamp).
    await insert([
      event(project, "2026-10-02 10:00:00.000", {
        event_type: "connection",
        event_name: null,
        session_id: "s-fleet",
        platform: "chatgpt",
        client_name: "openai-mcp",
      }),
      event(project, "2026-10-02 10:05:00.000", {
        event_type: "connection",
        event_name: null,
        session_id: "s-fleet",
        platform: "chatgpt",
        client_name: "openai-mcp",
      }),
      event(project, "2026-10-02 10:01:00.000", { session_id: "s-fleet" }),
      event(project, "2026-10-02 10:06:00.000", { session_id: "s-fleet" }),
    ]);
    await job(new MemoryStore([project])).runIfDue(NOW);
    const cells = await rows(
      "SELECT slice, event_type, events, individuals FROM stats_daily WHERE project_id = {p:String} AND slice IN ('total', 'client') ORDER BY slice, event_type",
      { p: project },
    );
    expect(
      cells.map((r) => [r.slice, r.event_type, Number(r.events), Number(r.individuals)]),
    ).toEqual([
      ["client", "connection", 1, 1],
      ["client", "tool_call", 2, 1],
      ["total", "connection", 1, 1],
      ["total", "tool_call", 2, 1],
    ]);
  });

  it("tool_registry: a tool reported by several processes is one row under FINAL, the latest report (#142)", async () => {
    await getClient().insert({
      table: "tool_registry",
      values: [
        {
          project_id: project,
          tool_name: "search",
          description: "first process",
          registered_at: "2026-10-01 00:00:00.000",
          updated_at: "2026-10-01 00:00:00.000",
        },
        {
          project_id: project,
          tool_name: "search",
          description: "second process",
          registered_at: "2026-10-01 00:00:05.000",
          updated_at: "2026-10-01 00:00:05.000",
        },
      ],
      format: "JSONEachRow",
    });
    const registry = await rows(
      "SELECT tool_name, description FROM tool_registry FINAL WHERE project_id = {p:String}",
      { p: project },
    );
    expect(registry).toEqual([{ tool_name: "search", description: "second process" }]);
  });

  describe("per-project retention (#93)", () => {
    it("deletes old raw events after aggregating them, in one statement, and keeps the statistics", async () => {
      const short = `p-short-${randomUUID().slice(0, 8)}`;
      const full = `p-full-${randomUUID().slice(0, 8)}`;
      await insert([
        event(short, "2026-06-20 10:00:00.000"),
        event(short, "2026-07-20 10:00:00.000"),
        event(short, "2026-08-10 10:00:00.000"),
        event(short, "2026-08-20 10:00:00.000"),
        event(short, "2026-09-20 10:00:00.000"),
        event(short, "2026-10-05 10:00:00.000"),
        event(full, "2026-06-20 10:00:00.000"),
      ]);
      const store = new MemoryStore([short, full]);
      store.retention.set(short, 2);

      const deletes: string[] = [];
      const spying = {
        query: rollup.query.bind(rollup),
        command: (params: Parameters<ClickHouseClient["command"]>[0]) => {
          if (params.query.startsWith("ALTER TABLE events DELETE")) deletes.push(params.query);
          return rollup.command(params);
        },
      } as unknown as ClickHouseClient;
      const run = () => new StatsJob({ clickhouse: spying, store, logger: silent });

      const report = await run().runIfDue(NOW);
      expect(report?.retention).toMatchObject({ status: "done", projects: 1 });
      expect(deletes).toHaveLength(1);

      // Raw events older than 2 months before NOW (2026-08-14 03:00) are gone,
      // and only for the project that keeps 2 months.
      const raw = await rows(
        "SELECT project_id, toString(toDate(timestamp)) AS d FROM events WHERE project_id IN ({a:String}, {b:String}) ORDER BY project_id, d",
        { a: short, b: full },
      );
      expect(raw.filter((r) => r.project_id === short).map((r) => r.d)).toEqual([
        "2026-08-20",
        "2026-09-20",
        "2026-10-05",
      ]);
      expect(raw.filter((r) => r.project_id === full).map((r) => r.d)).toEqual(["2026-06-20"]);

      // Everything was aggregated before the delete.
      const monthly = async () =>
        rows(
          `SELECT toString(toStartOfMonth(day)) AS m, sum(events) AS n FROM stats_daily
           WHERE project_id = {p:String} AND slice = 'total' GROUP BY m ORDER BY m`,
          { p: short },
        );
      const before = await monthly();
      expect(before.map((r) => [r.m, Number(r.n)])).toEqual([
        ["2026-06-01", 1],
        ["2026-07-01", 1],
        ["2026-08-01", 2],
        ["2026-09-01", 1],
        ["2026-10-01", 1],
      ]);

      // The next day: previous and current month are recomputed from the raw
      // events still there; August is frozen. No month's statistics change.
      const next = await run().runIfDue(new Date("2026-10-15T03:00:00Z"));
      expect(next?.retention.status).toBe("done");
      expect(await monthly()).toEqual(before);
    }, 60_000);

    it("leaves every statistics table unchanged across the delete, look-back measures included", async () => {
      // The issue's acceptance test, for all four tables. stats_daily reads
      // only its month; the other three look back — 29 days (WAU/MAU), up to
      // a year (quarter/year users), all history (cohort first-seen). Without
      // a floor, the day-2 recompute of September reads fewer events than
      // day 1 did, and its numbers drift.
      const short = `p-short-${randomUUID().slice(0, 8)}`;
      const user = (id: string, ts: string) => event(short, ts, { user_id: id });
      await insert([
        user("u1", "2026-06-10 10:00:00.000"), // first seen in June
        user("u1", "2026-08-10 10:00:00.000"), // deleted on day 1
        user("u1", "2026-09-20 10:00:00.000"),
        user("u2", "2026-08-20 10:00:00.000"),
        user("u2", "2026-09-05 10:00:00.000"),
        user("u3", "2026-07-15 10:00:00.000"), // only in Q3's deleted part
        user("u4", "2026-09-02 10:00:00.000"),
        user("u4", "2026-10-02 10:00:00.000"),
      ]);
      const store = new MemoryStore([short]);
      store.retention.set(short, 2);

      const snapshot = async () => {
        const out: Record<string, unknown[]> = {};
        for (const t of [
          "stats_daily",
          "stats_users_daily",
          "stats_users_periods",
          "stats_cohorts",
        ]) {
          out[t] = await rows(`SELECT * FROM ${t} WHERE project_id = {p:String} ORDER BY ALL`, {
            p: short,
          });
        }
        return out;
      };

      const day1 = await job(store).runIfDue(NOW);
      expect(day1?.retention.status).toBe("done");
      const afterDay1 = await snapshot();
      const day2 = await job(store).runIfDue(new Date("2026-10-15T03:00:00Z"));
      expect(day2?.tables.every((t) => t.status === "done")).toBe(true);
      // Every row day 1 wrote is unchanged; day 2 only adds the day that
      // closed in between (2026-10-14).
      const afterDay2 = await snapshot();
      const added = afterDay2.stats_users_daily.filter(
        (r) => (r as { day: string }).day === "2026-10-14",
      );
      expect(added).toHaveLength(1);
      expect({
        ...afterDay2,
        stats_users_daily: afterDay2.stats_users_daily.filter((r) => !added.includes(r)),
      }).toEqual(afterDay1);

      // What a 2-month window can honestly say about September (floor =
      // 2026-09-01): MAU counts only retained days; Q3 began before the
      // floor, so it has no distinct-user figure; and no September cohort,
      // because "first seen in September" cannot be told apart from "seen
      // before and deleted".
      const sep5 = afterDay1.stats_users_daily.find(
        (r) => (r as { day: string }).day === "2026-09-05",
      ) as { mau: string | number } | undefined;
      expect(Number(sep5?.mau)).toBe(2); // u4 (Sep 2), u2 (Sep 5) — not u1's Aug 10
      expect(
        afterDay1.stats_users_periods.filter((r) => (r as { period: string }).period === "quarter"),
      ).toEqual([]);
      expect(
        afterDay1.stats_cohorts.filter(
          (r) => (r as { activity_month: string }).activity_month >= "2026-09-01",
        ),
      ).toEqual([]);
    }, 60_000);

    it("deletes nothing when the aggregation failed in that run", async () => {
      const short = `p-short-${randomUUID().slice(0, 8)}`;
      await insert([
        event(short, "2026-06-20 10:00:00.000"),
        event(short, "2026-10-05 10:00:00.000"),
      ]);
      const store = new MemoryStore([short]);
      store.retention.set(short, 2);
      const failing = {
        query: rollup.query.bind(rollup),
        command: (params: Parameters<ClickHouseClient["command"]>[0]) => {
          if (params.query.includes("INSERT INTO stats_cohorts_stage")) {
            return Promise.reject(new Error("simulated failure"));
          }
          return rollup.command(params);
        },
      } as unknown as ClickHouseClient;

      const report = await new StatsJob({ clickhouse: failing, store, logger: silent }).runIfDue(
        NOW,
      );
      expect(report?.tables.find((t) => t.table === "stats_cohorts")?.status).toBe("failed");
      expect(report?.retention.status).toBe("skipped");
      const raw = await rows("SELECT count() AS n FROM events WHERE project_id = {p:String}", {
        p: short,
      });
      expect(Number(raw[0].n)).toBe(2);
    }, 60_000);

    it("needs no statement when every project keeps the platform window", async () => {
      await insert([event(project, "2026-10-05 10:00:00.000")]);
      const report = await job(new MemoryStore([project])).runIfDue(NOW);
      expect(report?.retention).toMatchObject({ status: "not-needed", projects: 0 });
    }, 60_000);
  });
});
