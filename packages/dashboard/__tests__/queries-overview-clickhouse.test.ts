import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_TEST_PASSWORD,
  adminClient,
  applyMigrations,
  clickhouseUrl,
} from "./helpers/clickhouse";

// #142: a stateless fleet emits one `connection` event per instance that
// served a conversation, with random ids and their own timestamps, so the
// rows never collapse. The dashboard counts sessions as distinct session_id
// over every event, never connection rows — proven here against a real
// ClickHouse, as yavio_dashboard, instead of a mocked query.

const url = clickhouseUrl();

type Overview = typeof import("@/lib/queries/overview");
let q: Overview;
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

describe.skipIf(!url)("overview KPIs on a real ClickHouse (#142)", () => {
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
    q = await import("@/lib/queries/overview");

    // One conversation served by three instances: three connection rows for
    // one session, plus its two calls. A second conversation served by one.
    await insert([
      {
        event_type: "connection",
        event_name: null,
        session_id: "s-fleet",
        timestamp: day(-2, "10:00:00.000"),
      },
      {
        event_type: "connection",
        event_name: null,
        session_id: "s-fleet",
        timestamp: day(-2, "10:00:01.000"),
      },
      {
        event_type: "connection",
        event_name: null,
        session_id: "s-fleet",
        timestamp: day(-2, "10:00:02.000"),
      },
      { session_id: "s-fleet", timestamp: day(-2, "10:00:03.000") },
      { session_id: "s-fleet", timestamp: day(-2, "10:00:04.000") },
      { event_type: "connection", event_name: null, session_id: "s-solo", timestamp: day(-1) },
      { session_id: "s-solo", timestamp: day(-1, "10:00:01.000") },
    ]);
  });

  afterAll(async () => {
    process.env.CLICKHOUSE_URL = savedEnv.CLICKHOUSE_URL;
    process.env.CLICKHOUSE_DASHBOARD_PASSWORD = savedEnv.CLICKHOUSE_DASHBOARD_PASSWORD;
    await admin.close();
  });

  it("counts a session once however many connection rows it has", async () => {
    const kpis = await q.queryOverviewKPIs({
      workspaceId: ws,
      projectId: project,
      from: day(-7, "00:00:00.000"),
      to: day(1, "00:00:00.000"),
    });
    const byLabel = Object.fromEntries(kpis.map((k) => [k.label, k.value]));
    expect(byLabel.Sessions).toBe(2);
    expect(byLabel.Invocations).toBe(3);
    // Rows from an SDK before 0.5.4 (no session_source): no hint.
    expect(kpis.find((k) => k.label === "Sessions")?.hint).toBeUndefined();
  });

  it("leaves per_request sessions out of Sessions and counts their calls in the hint (#144)", async () => {
    // One client without a session key on a per-request host: three calls,
    // three one-call sessions, one connection row for the process. One
    // keyed conversation of two calls next to it.
    const perRequestProject = `${project}-pr`;
    const rows = [
      {
        event_type: "connection",
        event_name: null,
        session_id: "s-pr-1",
        session_source: "per_request",
        timestamp: day(-1, "09:00:00.000"),
      },
      { session_id: "s-pr-1", session_source: "per_request", timestamp: day(-1, "09:00:01.000") },
      { session_id: "s-pr-2", session_source: "per_request", timestamp: day(-1, "09:00:02.000") },
      { session_id: "s-pr-3", session_source: "per_request", timestamp: day(-1, "09:00:03.000") },
      {
        event_type: "connection",
        event_name: null,
        session_id: "s-keyed",
        session_source: "custom",
        timestamp: day(-1, "10:00:00.000"),
      },
      { session_id: "s-keyed", session_source: "custom", timestamp: day(-1, "10:00:01.000") },
      { session_id: "s-keyed", session_source: "custom", timestamp: day(-1, "10:00:02.000") },
    ];
    await insert(rows.map((r) => ({ ...r, project_id: perRequestProject })));

    const kpis = await q.queryOverviewKPIs({
      workspaceId: ws,
      projectId: perRequestProject,
      from: day(-7, "00:00:00.000"),
      to: day(1, "00:00:00.000"),
    });
    const sessions = kpis.find((k) => k.label === "Sessions");
    expect(sessions?.value).toBe(1);
    expect(sessions?.hint).toBe("3 calls from clients without a session key");
    expect(kpis.find((k) => k.label === "Invocations")?.value).toBe(5);
  });
});
