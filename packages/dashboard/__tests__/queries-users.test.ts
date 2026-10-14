import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClickHouseClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { adminClient, applyMigrations, clickhouseUrl } from "./helpers/clickhouse";

// #89: every user query runs against a real ClickHouse, through the real
// queryAnalytics — as yavio_dashboard, with the row policies — instead of
// matching SQL text against a mock. That mock is why the retention query
// passed CI while it failed to parse on every call.

const url = clickhouseUrl();
const DASH_PASSWORD = "dash-users-test";

type Users = typeof import("@/lib/queries/users");
let q: Users;
let admin: ClickHouseClient;

const ws = `ws-${randomUUID().slice(0, 8)}`;
const project = `p-${randomUUID().slice(0, 8)}`;

function day(offsetDays: number, time = "10:00:00.000"): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  return `${d} ${time}`;
}

async function insert(rows: Array<Record<string, unknown>>) {
  await admin.insert({
    table: "events",
    values: rows.map((r) => ({
      event_id: randomUUID(),
      workspace_id: ws,
      project_id: project,
      trace_id: "t",
      session_id: "s",
      event_type: "tool_call",
      event_name: "search",
      source: "server",
      ...r,
    })),
    format: "JSONEachRow",
  });
}

const ctx = (from: string, to: string) => ({ workspaceId: ws, projectId: project, from, to });

describe.skipIf(!url)("user queries on a real ClickHouse (#89)", () => {
  const savedEnv = {
    CLICKHOUSE_URL: process.env.CLICKHOUSE_URL,
    CLICKHOUSE_DASHBOARD_PASSWORD: process.env.CLICKHOUSE_DASHBOARD_PASSWORD,
  };

  beforeAll(async () => {
    admin = adminClient(url as URL);
    await applyMigrations(admin);
    await admin.command({ query: `ALTER USER yavio_dashboard IDENTIFIED BY '${DASH_PASSWORD}'` });
    process.env.CLICKHOUSE_URL = (url as URL).toString();
    process.env.CLICKHOUSE_DASHBOARD_PASSWORD = DASH_PASSWORD;
    vi.resetModules();
    q = await import("@/lib/queries/users");

    // #89's reproduction: one user, 9 events over 3 insert batches in one
    // month, 1 event a month later. users_mv collapsed this to 3 events,
    // 1 session and a frozen last_seen.
    for (const [batch, sessions] of [
      [0, ["s1", "s2"]],
      [1, ["s2", "s3"]],
      [2, ["s3"]],
    ] as const) {
      await insert(
        Array.from({ length: 3 }, (_, i) => ({
          user_id: "anna",
          session_id: sessions[i % sessions.length],
          timestamp: day(-40 + batch, `0${i}:00:00.000`),
        })),
      );
    }
    await insert([{ user_id: "anna", session_id: "s4", timestamp: day(-5) }]);

    // Before and after identify(): the same person.
    await insert([
      { subject_id: "sub-ben", session_id: "b1", timestamp: day(-3, "08:00:00.000") },
      { subject_id: "sub-ben", session_id: "b1", timestamp: day(-3, "08:05:00.000") },
      {
        subject_id: "sub-ben",
        user_id: "ben",
        session_id: "b1",
        timestamp: day(-3, "08:10:00.000"),
      },
    ]);
    // Never identified: counted by subject_id.
    await insert([{ subject_id: "sub-cleo", session_id: "c1", timestamp: day(-2) }]);
    // No user key at all, and an empty user_id: not a person.
    await insert([
      { session_id: "x1", timestamp: day(-2) },
      { user_id: "", session_id: "x2", timestamp: day(-2) },
    ]);
    // Last seen 14 months ago and again today: the old event is past the
    // 13-month TTL (dropped on insert), so the user counts as new.
    await insert([
      { user_id: "dora", timestamp: day(-425) },
      { user_id: "dora", timestamp: day(0, "00:30:00.000") },
    ]);
    // Another project in the same workspace: invisible to these queries.
    await admin.insert({
      table: "events",
      values: [
        {
          event_id: randomUUID(),
          workspace_id: ws,
          project_id: `${project}-other`,
          trace_id: "t",
          session_id: "o",
          event_type: "tool_call",
          source: "server",
          user_id: "outsider",
          timestamp: day(-1),
        },
      ],
      format: "JSONEachRow",
    });
  });

  afterAll(async () => {
    await admin?.close();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });

  it("lists users with exact totals, first and last seen (the #89 reproduction)", async () => {
    const { users, total } = await q.queryUserList(ctx(day(-60), day(1)), 1, 50, "userId", "asc");
    expect(total).toBe(4);
    const anna = users.find((u) => u.userId === "anna");
    expect(Number(anna?.totalEvents)).toBe(10);
    expect(Number(anna?.totalSessions)).toBe(4);
    expect(anna?.firstSeen.slice(0, 10)).toBe(day(-40).slice(0, 10));
    expect(anna?.lastSeen.slice(0, 10)).toBe(day(-5).slice(0, 10));
    // Stitched: ben's three events, two of them before identify().
    const ben = users.find((u) => u.userId === "ben");
    expect(Number(ben?.totalEvents)).toBe(3);
    expect(users.map((u) => u.userId).sort()).toEqual(["anna", "ben", "dora", "sub-cleo"]);
  });

  it("counts a user seen only 14 months ago and again today as new", async () => {
    const points = await q.queryNewVsReturning(
      ctx(day(-1, "00:00:00.000"), day(1, "00:00:00.000")),
      "day",
    );
    const today = points.find((p) => p.bucket.slice(0, 10) === day(0).slice(0, 10));
    expect(Number(today?.newUsers)).toBe(1);
    expect(Number(today?.returningUsers)).toBe(0);
  });

  it("counts active users by the stitched key, never by session", async () => {
    const points = await q.queryActiveUsers(
      ctx(day(-3, "00:00:00.000"), day(-1, "00:00:00.000")),
      "day",
    );
    const benDay = points.find((p) => p.bucket.slice(0, 10) === day(-3).slice(0, 10));
    const cleoDay = points.find((p) => p.bucket.slice(0, 10) === day(-2).slice(0, 10));
    expect(Number(benDay?.dau)).toBe(1); // ben, once — not twice
    // cleo only; x1/x2 have no user key.
    expect(Number(cleoDay?.dau)).toBe(1);
    // ben (3 days ago), cleo — and anna's event 5 days ago is in the 7 days.
    expect(Number(cleoDay?.wau)).toBe(3);
    // + nothing older inside 30 days but anna's -5: still 3.
    expect(Number(cleoDay?.mau)).toBe(3);
  });

  it("returns retention cohorts in period order, zero-filled", async () => {
    // A dedicated project: first seen in week 0, back in week 2, not week 1.
    const cohortProject = `${project}-cohort`;
    const base = day(-35, "12:00:00.000");
    const plusDays = (n: number) =>
      new Date(Date.parse(`${base.replace(" ", "T")}Z`) + n * 86_400_000)
        .toISOString()
        .replace("T", " ")
        .slice(0, 23);
    await admin.insert({
      table: "events",
      values: [
        { user_id: "w0-only", timestamp: plusDays(0) },
        { user_id: "w0-w2", timestamp: plusDays(0) },
        { user_id: "w0-w2", timestamp: plusDays(14) },
      ].map((r) => ({
        event_id: randomUUID(),
        workspace_id: ws,
        project_id: cohortProject,
        trace_id: "t",
        session_id: "s",
        event_type: "tool_call",
        source: "server",
        ...r,
      })),
      format: "JSONEachRow",
    });
    const cohorts = await q.queryRetentionCohorts(
      { workspaceId: ws, projectId: cohortProject, from: plusDays(-1), to: plusDays(21) },
      "week",
    );
    expect(cohorts).toHaveLength(1);
    expect(Number(cohorts[0].cohortSize)).toBe(2);
    expect(cohorts[0].retentionByPeriod.map(Number)).toEqual([2, 0, 1]);
  });

  it("finds a user's events by the key, also for a user known only by subject_id", async () => {
    const events = await q.queryUserDetail(ctx(day(-60), day(1)), "sub-cleo");
    expect(events).toHaveLength(1);
    const ben = await q.queryUserDetail(ctx(day(-60), day(1)), "ben");
    expect(ben).toHaveLength(3);
  });

  it("shows the detail of a user identified before the selected range (#112)", async () => {
    // A later session of ben's that never reaches identify(): subject only.
    // The list attributes it to ben through the all-time mapping, so the
    // detail page for the same range must find it as well — the stitch for
    // a named user is never bounded to the range.
    await insert([{ subject_id: "sub-ben", session_id: "b2", timestamp: day(-1) }]);
    const inRange = await q.queryUserDetail(ctx(day(-2), day(1)), "ben");
    expect(inRange).toHaveLength(1);
    expect(inRange[0].sessionId).toBe("b2");
  });
});

describe("no query reads users_mv / sessions_mv any more (#89 release 1)", () => {
  it("in the user queries", () => {
    const src = readFileSync(join(process.cwd(), "lib/queries/users.ts"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(src).not.toMatch(/users_mv|sessions_mv/);
  });

  it("in the MCP surface", async () => {
    const { QUERYABLE_TABLES } = await import("@/lib/mcp/sql-guard");
    expect(QUERYABLE_TABLES).not.toContain("users_mv");
    expect(QUERYABLE_TABLES).not.toContain("sessions_mv");
    const { SCHEMA_DOC } = await import("@/lib/mcp/schema-doc");
    expect(SCHEMA_DOC).not.toMatch(/users_mv|sessions_mv/);
  });
});
