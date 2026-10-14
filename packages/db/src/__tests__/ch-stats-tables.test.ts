import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnect, getClient, runMigrations } from "./helpers/clickhouse.js";

// Migration 0015 (#85): the anonymous statistics tier.

const STATS = ["stats_daily", "stats_users_daily", "stats_users_periods", "stats_cohorts"];

// The exact column list of every stats table. A new column — the way an
// identifier would slip into a table kept indefinitely — fails this test and
// has to be added here on purpose.
const ALLOWED_COLUMNS: Record<string, string[]> = {
  stats_daily: [
    "workspace_id",
    "project_id",
    "slice",
    "day",
    "event_type",
    "event_name",
    "status",
    "error_category",
    "platform",
    "client_name",
    "country_code",
    "language",
    "conversion_currency",
    "events",
    "individuals",
    "latency_sum",
    "latency_count",
    "conversions",
    "conversion_value",
  ],
  stats_users_daily: ["workspace_id", "project_id", "day", "dau", "wau", "mau"],
  stats_users_periods: [
    "workspace_id",
    "project_id",
    "period",
    "period_start",
    "period_end",
    "users",
  ],
  stats_cohorts: [
    "workspace_id",
    "project_id",
    "cohort_month",
    "activity_month",
    "month_offset",
    "users",
  ],
};

const HTTP = (() => {
  const url = new URL(process.env.CLICKHOUSE_URL ?? "http://localhost:8123");
  url.username = "";
  url.password = "";
  return url.toString();
})();

async function asUser(
  user: string,
  password: string,
  query: string,
  settings = "",
): Promise<string> {
  const res = await fetch(`${HTTP}?${settings}`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` },
    body: query,
  });
  return res.text();
}

describe("anonymous statistics tables (0015)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await disconnect();
  });

  it.each(STATS)("%s and its stage have no TTL", async (table) => {
    for (const t of [table, `${table}_stage`]) {
      const r = await getClient().query({
        query: `SHOW CREATE TABLE ${t}`,
        format: "TabSeparatedRaw",
      });
      expect(await r.text()).not.toMatch(/\bTTL\b/);
    }
  });

  it.each(STATS)("%s has exactly the allowed columns, and so does its stage", async (table) => {
    for (const t of [table, `${table}_stage`]) {
      const r = await getClient().query({
        query:
          "SELECT name FROM system.columns WHERE database = 'default' AND table = {t:String} ORDER BY position",
        query_params: { t },
        format: "JSONEachRow",
      });
      expect((await r.json<{ name: string }>()).map((c) => c.name)).toEqual(ALLOWED_COLUMNS[table]);
    }
  });

  it("stores no aggregate-function states (they keep testable id hashes)", async () => {
    const r = await getClient().query({
      query: `SELECT table, name, type FROM system.columns WHERE database = 'default'
              AND table LIKE 'stats\\_%' AND type ILIKE '%AggregateFunction%'`,
      format: "JSONEachRow",
    });
    expect(await r.json()).toEqual([]);
  });

  it("yavio_rollup holds exactly the job's privileges", async () => {
    const r = await getClient().query({
      query:
        "SELECT table, toString(access_type) AS access FROM system.grants WHERE user_name = 'yavio_rollup'",
      format: "JSONEachRow",
    });
    const byTable = new Map<string, string[]>();
    for (const g of await r.json<{ table: string; access: string }>()) {
      byTable.set(g.table, [...(byTable.get(g.table) ?? []), g.access].sort());
    }
    const actual = [...byTable].map(([table, access]) => ({ table, access }));
    actual.sort((a, b) => (a.table < b.table ? -1 : 1));
    const expected = [
      { table: "events", access: ["SELECT"] },
      { table: "tool_registry", access: ["SELECT"] },
      // REPLACE PARTITION needs INSERT and ALTER DELETE on the target, and
      // SELECT on its source (checked on 26.8).
      ...STATS.map((t) => ({ table: t, access: ["ALTER DELETE", "INSERT"] })),
      ...STATS.map((t) => ({ table: `${t}_stage`, access: ["INSERT", "SELECT", "TRUNCATE"] })),
    ].sort((a, b) => (a.table < b.table ? -1 : 1));
    expect(actual).toEqual(expected);
  });

  it("every row policy applies to yavio_dashboard (an empty apply list protects nobody)", async () => {
    const r = await getClient().query({
      query:
        "SELECT short_name, table, apply_to_list FROM system.row_policies ORDER BY table, short_name",
      format: "JSONEachRow",
    });
    const policies = await r.json<{ short_name: string; table: string; apply_to_list: string[] }>();
    expect(policies.length).toBeGreaterThan(0);
    for (const t of STATS) {
      expect(
        policies
          .filter((p) => p.table === t)
          .map((p) => p.short_name)
          .sort(),
      ).toEqual(["project_isolation", "workspace_isolation"]);
    }
    expect(policies.filter((p) => p.apply_to_list.join() !== "yavio_dashboard")).toEqual([]);
  });

  describe("row policies — yavio_dashboard sees its own workspace and project only", () => {
    beforeAll(async () => {
      const ch = getClient();
      await ch.command({ query: "ALTER USER yavio_dashboard IDENTIFIED BY 'stats-test'" });
      await ch.command({ query: "TRUNCATE TABLE stats_daily" });
      await ch.insert({
        table: "stats_daily",
        values: [
          {
            workspace_id: "ws-a",
            project_id: "p-a1",
            slice: "total",
            day: "2026-10-01",
            event_type: "tool_call",
            events: 3,
            individuals: 2,
          },
          {
            workspace_id: "ws-a",
            project_id: "p-a2",
            slice: "total",
            day: "2026-10-01",
            event_type: "tool_call",
            events: 5,
            individuals: 4,
          },
          {
            workspace_id: "ws-b",
            project_id: "p-b1",
            slice: "total",
            day: "2026-10-01",
            event_type: "tool_call",
            events: 7,
            individuals: 6,
          },
        ],
        format: "JSONEachRow",
      });
    });

    it("another workspace and another project are invisible", async () => {
      const out = await asUser(
        "yavio_dashboard",
        "stats-test",
        "SELECT project_id, events FROM stats_daily ORDER BY project_id FORMAT TSV",
        "SQL_workspace_id=ws-a&SQL_project_id=p-a1",
      );
      expect(out.trim()).toBe("p-a1\t3");
    });

    it("fails closed without the settings", async () => {
      const out = await asUser("yavio_dashboard", "stats-test", "SELECT count() FROM stats_daily");
      expect(out).toMatch(/Code: 115|UNKNOWN_SETTING|Unknown setting/);
    });

    it("cannot read the stage tables", async () => {
      const out = await asUser(
        "yavio_dashboard",
        "stats-test",
        "SELECT count() FROM stats_daily_stage",
        "SQL_workspace_id=ws-a&SQL_project_id=p-a1",
      );
      expect(out).toMatch(/ACCESS_DENIED|Not enough privileges/);
    });
  });
});
