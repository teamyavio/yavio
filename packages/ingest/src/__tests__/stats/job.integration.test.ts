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
  constructor(public projects: string[]) {}
  async withLock<T>(fn: (s: StatsJobSession) => Promise<T>): Promise<T | null> {
    if (this.locked) return null;
    return fn({
      listProjectIds: async () => this.projects,
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
    await insert(batch);
    // Stored a second time, past insert deduplication (as before #90).
    await insert(batch, { insert_deduplicate: 0 });
    const raw = await rows("SELECT count() AS n FROM events WHERE project_id = {p:String}", {
      p: project,
    });
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
});
