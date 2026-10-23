import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_TEST_PASSWORD,
  adminClient,
  applyMigrations,
  clickhouseUrl,
} from "./helpers/clickhouse";

// #145: the per-row lists on a real ClickHouse, as yavio_dashboard. identify()
// stamps user_id only on the events of the SDK process that called it, so a
// call another instance served in the same conversation names no user. The
// invocation feed and a tool's recent invocations resolve it through one
// lookup over the page's sessions.

const url = clickhouseUrl();

type Invocations = typeof import("@/lib/queries/invocations");
type ToolDetail = typeof import("@/lib/queries/tool-detail");
let feed: Invocations;
let tool: ToolDetail;
let admin: ClickHouseClient;

const ws = `ws-${randomUUID().slice(0, 8)}`;
const project = `p-${randomUUID().slice(0, 8)}`;

function day(offsetDays: number, time = "10:00:00.000"): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  return `${d} ${time}`;
}

const ids = {
  a: randomUUID(),
  b: randomUUID(),
  old: randomUUID(),
  subject: randomUUID(),
  hal: randomUUID(),
  two: randomUUID(),
  none: randomUUID(),
  empty: randomUUID(),
};

async function insert(rows: Array<Record<string, unknown>>) {
  await admin.insert({
    table: "events",
    values: rows.map((r) => ({
      event_id: randomUUID(),
      workspace_id: ws,
      project_id: project,
      trace_id: `t-${randomUUID().slice(0, 8)}`,
      event_type: "tool_call",
      event_name: "search",
      source: "server",
      status: "success",
      ...r,
    })),
    format: "JSONEachRow",
  });
}

const identify = (user: string, session: string, timestamp: string) => ({
  event_type: "identify",
  event_name: null,
  status: null,
  user_id: user,
  session_id: session,
  timestamp,
});

const ctx = { workspaceId: ws, projectId: project, from: day(-3), to: day(1) };

describe.skipIf(!url)(
  "per-row lists resolve the session's user on a real ClickHouse (#145)",
  () => {
    const savedEnv = {
      CLICKHOUSE_URL: process.env.CLICKHOUSE_URL,
      CLICKHOUSE_DASHBOARD_PASSWORD: process.env.CLICKHOUSE_DASHBOARD_PASSWORD,
    };

    beforeAll(async () => {
      admin = adminClient(url as URL);
      await applyMigrations(admin);
      await admin.command({
        query: `ALTER USER yavio_dashboard IDENTIFIED BY '${DASHBOARD_TEST_PASSWORD}'`,
      });
      process.env.CLICKHOUSE_URL = (url as URL).toString();
      process.env.CLICKHOUSE_DASHBOARD_PASSWORD = DASHBOARD_TEST_PASSWORD;
      vi.resetModules();
      feed = await import("@/lib/queries/invocations");
      tool = await import("@/lib/queries/tool-detail");

      await insert([
        // Process A identifies and calls; process B serves the next call.
        identify("eve", "conv-a", day(-2, "10:00:00.000")),
        {
          event_id: ids.a,
          user_id: "eve",
          session_id: "conv-a",
          timestamp: day(-2, "10:00:00.001"),
        },
        { event_id: ids.b, session_id: "conv-a", timestamp: day(-2, "10:05:00.000") },
        // Identified long before the selected range.
        identify("kim", "conv-old", day(-20, "09:00:00.000")),
        { event_id: ids.old, session_id: "conv-old", timestamp: day(-1, "09:00:00.000") },
        // Never identified: the feed falls back to the subject.
        {
          event_id: ids.subject,
          subject_id: "sub-x",
          session_id: "conv-sub",
          timestamp: day(-1, "10:00:00.000"),
        },
        // Two processes accepted different ids: a stamped row keeps its own,
        // an unstamped one takes the first.
        identify("gus", "conv-two", day(-1, "11:00:00.000")),
        identify("hal", "conv-two", day(-1, "11:30:00.000")),
        {
          event_id: ids.hal,
          user_id: "hal",
          session_id: "conv-two",
          timestamp: day(-1, "11:30:00.001"),
        },
        { event_id: ids.two, session_id: "conv-two", timestamp: day(-1, "12:00:00.000") },
        // No session: never mapped, not even to an identify without one.
        identify("jon", "", day(-1, "13:00:00.000")),
        { event_id: ids.none, session_id: "", timestamp: day(-1, "13:00:00.001") },
        // An identify with an empty id first (the SDK accepts it): skipped.
        identify("", "conv-empty", day(-1, "14:00:00.000")),
        identify("bob", "conv-empty", day(-1, "14:05:00.000")),
        { event_id: ids.empty, session_id: "conv-empty", timestamp: day(-1, "14:10:00.000") },
      ]);
    });

    afterAll(async () => {
      await admin?.close();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    });

    const names = Object.fromEntries(Object.entries(ids).map(([name, id]) => [id, name]));
    const byName = (rows: Array<{ eventId: string; userId: string | null }>) =>
      Object.fromEntries(rows.map((r) => [names[r.eventId], r.userId || null]));

    it("in the invocation feed", async () => {
      const { invocations, total } = await feed.queryInvocationFeed(ctx, 1, 25);
      expect(total).toBe(8);
      expect(byName(invocations)).toEqual({
        a: "eve",
        b: "eve",
        old: "kim",
        subject: "sub-x",
        hal: "hal",
        two: "gus",
        none: null,
        empty: "bob",
      });
    });

    it("in a tool's recent invocations", async () => {
      const { invocations, total } = await tool.queryToolRecentInvocations(ctx, "search", 1, 25);
      expect(Number(total)).toBe(8);
      expect(byName(invocations)).toEqual({
        a: "eve",
        b: "eve",
        old: "kim",
        subject: null,
        hal: "hal",
        two: "gus",
        none: null,
        empty: "bob",
      });
    });
  },
);
