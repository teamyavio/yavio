import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClickHouseClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_TEST_PASSWORD,
  adminClient,
  applyMigrations,
  clickhouseUrl,
} from "./helpers/clickhouse";

// #89: every user query runs against a real ClickHouse, through the real
// queryAnalytics — as yavio_dashboard, with the row policies — instead of
// matching SQL text against a mock. That mock is why the retention query
// passed CI while it failed to parse on every call.

const url = clickhouseUrl();
const DASH_PASSWORD = DASHBOARD_TEST_PASSWORD;

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

  it("totalSessions leaves per_request sessions out; the user and their events still count (#144)", async () => {
    // Erik's client sends no session key to a per-request host: three calls,
    // three one-call sessions. One keyed conversation besides, and one
    // session from an SDK before 0.5.4 (no session_source).
    const other = `${project}-pr`;
    const rows = [
      { session_id: "e-pr-1", session_source: "per_request", timestamp: day(-2, "08:00:00.000") },
      { session_id: "e-pr-2", session_source: "per_request", timestamp: day(-2, "08:01:00.000") },
      { session_id: "e-pr-3", session_source: "per_request", timestamp: day(-2, "08:02:00.000") },
      { session_id: "e-keyed", session_source: "custom", timestamp: day(-2, "09:00:00.000") },
      { session_id: "e-old", timestamp: day(-2, "10:00:00.000") },
    ];
    await insert(rows.map((r) => ({ ...r, user_id: "erik", project_id: other })));

    const { users, total } = await q.queryUserList(
      { workspaceId: ws, projectId: other, from: day(-60), to: day(1) },
      1,
      50,
    );
    expect(total).toBe(1);
    expect(users[0]?.userId).toBe("erik");
    expect(Number(users[0]?.totalSessions)).toBe(2);
    expect(Number(users[0]?.totalEvents)).toBe(5);
    expect(Number(users[0]?.totalToolCalls)).toBe(5);
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

  // #145: identify() stamps user_id only on the events of the SDK process
  // that called it. Each scenario has its own project and its own session
  // ids: several users above share the default session "s", which is safe
  // only because the session map reads identify rows.
  describe("the session stitch (#145)", () => {
    const scoped = (name: string) => {
      const projectId = `${project}-${name}`;
      return {
        projectId,
        ctx: (from: string, to: string) => ({ workspaceId: ws, projectId, from, to }),
        insert: (rows: Array<Record<string, unknown>>) =>
          admin.insert({
            table: "events",
            values: rows.map((r) => ({
              event_id: randomUUID(),
              workspace_id: ws,
              project_id: projectId,
              trace_id: `t-${randomUUID().slice(0, 8)}`,
              event_type: "tool_call",
              event_name: "search",
              source: "server",
              ...r,
            })),
            format: "JSONEachRow",
          }),
      };
    };
    const identify = (user: string, session: string, timestamp: string) => ({
      event_type: "identify",
      event_name: null,
      user_id: user,
      session_id: session,
      timestamp,
    });

    describe("a second process's calls go to the user the first identified", () => {
      // Process A identifies and calls; process B serves the next call of the
      // same conversation a day later and has never seen identify().
      const p = scoped("fleet");
      beforeAll(async () => {
        await p.insert([
          identify("eve", "conv-eve", day(-4, "08:00:00.000")),
          { user_id: "eve", session_id: "conv-eve", timestamp: day(-4, "08:00:00.001") },
          { session_id: "conv-eve", timestamp: day(-3, "09:00:00.000") },
        ]);
      });

      it("in the users list", async () => {
        const { users, total } = await q.queryUserList(p.ctx(day(-60), day(1)), 1, 50);
        expect(
          users.map((u) => [u.userId, Number(u.totalToolCalls), Number(u.totalSessions)]),
        ).toEqual([["eve", 2, 1]]);
        expect(total).toBe(1);
      });

      it("in the user detail", async () => {
        const detail = await q.queryUserDetail(p.ctx(day(-60), day(1)), "eve");
        expect(detail.map((e) => `${e.eventType} ${String(e.timestamp).slice(0, 10)}`)).toEqual([
          `tool_call ${day(-3).slice(0, 10)}`,
          `tool_call ${day(-4).slice(0, 10)}`,
          `identify ${day(-4).slice(0, 10)}`,
        ]);
      });

      it("in active users, on process B's day", async () => {
        const points = await q.queryActiveUsers(
          p.ctx(day(-4, "00:00:00.000"), day(-2, "00:00:00.000")),
          "day",
        );
        const dayB = points.find((pt) => pt.bucket.slice(0, 10) === day(-3).slice(0, 10));
        expect(Number(dayB?.dau)).toBe(1);
      });
    });

    it("counts the session's events before identify() for the user", async () => {
      const p = scoped("before");
      await p.insert([
        { session_id: "conv-fay", timestamp: day(-2, "07:00:00.000") },
        identify("fay", "conv-fay", day(-2, "07:05:00.000")),
        { user_id: "fay", session_id: "conv-fay", timestamp: day(-2, "07:06:00.000") },
      ]);
      const { users } = await q.queryUserList(p.ctx(day(-60), day(1)), 1, 50);
      expect(users).toHaveLength(1);
      expect(users[0].userId).toBe("fay");
      expect(Number(users[0].totalEvents)).toBe(3);
      expect(Number(users[0].totalToolCalls)).toBe(2);
      expect(users[0].firstSeen).toBe(day(-2, "07:00:00.000"));
    });

    it("gives unstamped rows to the session's first identified user; stamped rows keep their id", async () => {
      // Two processes accepted different ids for one conversation (YAVIO-1302
      // is per process); a third never identified.
      const p = scoped("two-ids");
      await p.insert([
        identify("gus", "conv-two", day(-2, "10:00:00.000")),
        { user_id: "gus", session_id: "conv-two", timestamp: day(-2, "10:01:00.000") },
        identify("hal", "conv-two", day(-2, "11:00:00.000")),
        { user_id: "hal", session_id: "conv-two", timestamp: day(-2, "11:01:00.000") },
        { session_id: "conv-two", timestamp: day(-2, "12:00:00.000") },
      ]);
      const { users, total } = await q.queryUserList(p.ctx(day(-60), day(1)), 1, 50);
      const rows = users.map((u) => [u.userId, Number(u.totalToolCalls), Number(u.totalEvents)]);
      expect(rows.sort()).toEqual([
        ["gus", 2, 3],
        ["hal", 1, 2],
      ]);
      expect(total).toBe(2);
    });

    it("prefers the session's identify over the user last seen with the subject", async () => {
      // One ChatGPT subject, two people (a shared account): mo in an earlier
      // conversation, ned identified in this one. The call before ned's
      // identify is ned's — direct evidence beats the cross-conversation
      // inference.
      const p = scoped("order");
      await p.insert([
        {
          user_id: "mo",
          subject_id: "sub-shared",
          session_id: "conv-mo",
          timestamp: day(-5, "10:00:00.000"),
        },
        { subject_id: "sub-shared", session_id: "conv-ned", timestamp: day(-2, "10:00:00.000") },
        identify("ned", "conv-ned", day(-2, "10:05:00.000")),
      ]);
      const { users } = await q.queryUserList(p.ctx(day(-60), day(1)), 1, 50);
      const rows = users.map((u) => [u.userId, Number(u.totalToolCalls), Number(u.totalEvents)]);
      expect(rows.sort()).toEqual([
        ["mo", 1, 1],
        ["ned", 1, 2],
      ]);
    });

    it("skips an identify with an empty id: the session's first real id takes its calls (review round 1)", async () => {
      // The SDK accepts identify(""), and "" passes its YAVIO-1302 check, so
      // identify("bob") on the same session state follows it.
      const p = scoped("empty-id");
      await p.insert([
        identify("", "conv-empty", day(-2, "10:00:00.000")),
        identify("bob", "conv-empty", day(-2, "10:05:00.000")),
        { session_id: "conv-empty", timestamp: day(-2, "10:10:00.000") },
      ]);
      const { users, total } = await q.queryUserList(p.ctx(day(-60), day(1)), 1, 50);
      expect(users.map((u) => [u.userId, Number(u.totalToolCalls), Number(u.totalEvents)])).toEqual(
        // The call and both identify rows: the empty one is an unstamped
        // event of the session like any other.
        [["bob", 1, 3]],
      );
      expect(total).toBe(1);
    });

    it("never maps an event without a session, nor across projects", async () => {
      const p = scoped("guards");
      const other = scoped("guards-other");
      // The same session id, identified in another project of the workspace.
      await other.insert([identify("ivy", "conv-shared", day(-2, "09:00:00.000"))]);
      await p.insert([
        { session_id: "conv-shared", timestamp: day(-2, "09:01:00.000") },
        // An identify and a call without a session: the identify counts for
        // jon by its own user_id, the call for nobody.
        identify("jon", "", day(-2, "10:00:00.000")),
        { session_id: "", timestamp: day(-2, "10:01:00.000") },
      ]);
      const { users, total } = await q.queryUserList(p.ctx(day(-60), day(1)), 1, 50);
      expect(users.map((u) => [u.userId, Number(u.totalToolCalls), Number(u.totalEvents)])).toEqual(
        [["jon", 0, 1]],
      );
      expect(total).toBe(1);
    });

    it("stitches windowed counts from their window, the list and the detail from all of it (#112)", async () => {
      // kim identified 40 days ago; the conversation goes on yesterday on
      // another process. The active-users window (the range plus 30 days)
      // does not reach the identify; the list and the detail of kim do.
      const p = scoped("window");
      await p.insert([
        identify("kim", "conv-kim", day(-40, "09:00:00.000")),
        { session_id: "conv-kim", timestamp: day(-1, "09:00:00.000") },
      ]);
      const detail = await q.queryUserDetail(p.ctx(day(-2), day(1)), "kim");
      expect(detail.map((e) => e.eventType)).toEqual(["tool_call"]);
      const { users } = await q.queryUserList(p.ctx(day(-60), day(1)), 1, 50);
      expect(users.map((u) => [u.userId, Number(u.totalToolCalls)])).toEqual([["kim", 1]]);

      const points = await q.queryActiveUsers(
        p.ctx(day(-1, "00:00:00.000"), day(0, "00:00:00.000")),
        "day",
      );
      expect(points.map((pt) => Number(pt.dau))).toEqual([0]);
    });

    it("get_schema's run_query recipe passes the SQL guard and keys calls like the dashboard's windowed counts", async () => {
      const { USER_KEY_SQL } = await import("@/lib/mcp/schema-doc");
      const { validateFreeQuery } = await import("@/lib/mcp/sql-guard");
      const { queryAnalytics } = await import("@/lib/clickhouse/analytics-client");
      const { keyedEvents } = await import("@/lib/queries/users");
      const p = scoped("recipe");
      await p.insert([
        // A call before identify and one on a second instance, two ids in one
        // session, a subject seen with a user, a subject never identified, a
        // call without any key.
        { session_id: "r1", timestamp: day(-3, "08:00:00.000") },
        identify("ana", "r1", day(-3, "08:01:00.000")),
        { session_id: "r1", timestamp: day(-2, "08:00:00.000") },
        identify("bo", "r2", day(-2, "09:00:00.000")),
        identify("cy", "r2", day(-2, "09:30:00.000")),
        { session_id: "r2", timestamp: day(-2, "10:00:00.000") },
        { user_id: "dee", subject_id: "sub-dee", session_id: "r3", timestamp: day(-2) },
        { subject_id: "sub-dee", session_id: "r4", timestamp: day(-1) },
        { subject_id: "sub-eli", session_id: "r5", timestamp: day(-1) },
        { session_id: "r6", timestamp: day(-1) },
        // Identified 40 days ago: outside the window, so no user inside it.
        identify("fay", "r7", day(-40)),
        { session_id: "r7", timestamp: day(-1) },
      ]);
      type Row = { person: string | null; tool_calls: string };
      const asMap = (rows: Row[]) =>
        Object.fromEntries(rows.map((r) => [String(r.person), Number(r.tool_calls)]));
      const recipe = await queryAnalytics<Row>({
        workspaceId: ws,
        projectId: p.projectId,
        query: validateFreeQuery(USER_KEY_SQL),
      });
      const window = { from: "now() - INTERVAL 30 DAY", to: "now() + INTERVAL 1 DAY" };
      const keyed = keyedEvents({
        events: window,
        stitch: window,
        rows: "AND e.event_type = 'tool_call'",
      });
      const dashboard = await queryAnalytics<Row>({
        workspaceId: ws,
        projectId: p.projectId,
        query: `WITH ${keyed} SELECT user_key AS person, count() AS tool_calls FROM keyed GROUP BY person`,
        params: { projectId: p.projectId },
      });
      expect(asMap(recipe)).toEqual({ ana: 2, bo: 1, dee: 2, "sub-eli": 1, null: 2 });
      expect(asMap(recipe)).toEqual(asMap(dashboard));
    });
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
