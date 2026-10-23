import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_TEST_PASSWORD,
  adminClient,
  applyMigrations,
  clickhouseUrl,
} from "./helpers/clickhouse";

// #129: the Locations card runs against a real ClickHouse, through the real
// queryAnalytics — as yavio_dashboard, with the row policies — like the user
// queries (#89).

const url = clickhouseUrl();
const DASH_PASSWORD = DASHBOARD_TEST_PASSWORD;

type Overview = typeof import("@/lib/queries/overview");
let q: Overview;
let admin: ClickHouseClient;

const ws = `ws-${randomUUID().slice(0, 8)}`;
const project = `p-${randomUUID().slice(0, 8)}`;

function day(offsetDays: number, time = "10:00:00.000"): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  return `${d} ${time}`;
}

async function insert(rows: Array<Record<string, unknown>>, scope = { ws, project }) {
  await admin.insert({
    table: "events",
    values: rows.map((r) => ({
      event_id: randomUUID(),
      workspace_id: scope.ws,
      project_id: scope.project,
      trace_id: "t",
      session_id: "s",
      event_type: "tool_call",
      event_name: "search",
      source: "server",
      platform: "chatgpt",
      timestamp: day(-2),
      ...r,
    })),
    format: "JSONEachRow",
  });
}

const ctx = (from: string, to: string, platform?: string[]) => ({
  workspaceId: ws,
  projectId: project,
  from,
  to,
  platform,
});

describe.skipIf(!url)("location breakdown on a real ClickHouse (#129)", () => {
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
    q = await import("@/lib/queries/overview");

    const de = { country_code: "DE" };
    await insert([
      // Germany: 6 calls from 4 people. sub-a appears in two regions.
      { ...de, region: "North Rhine-Westphalia", subject_id: "sub-a" },
      { ...de, region: "North Rhine-Westphalia", subject_id: "sub-a" },
      // identify(): sub-b's events stitch to bob, still one person
      { ...de, region: "North Rhine-Westphalia", subject_id: "sub-b", user_id: "bob" },
      { ...de, region: "State of Berlin", subject_id: "sub-a" },
      { ...de, region: "State of Berlin", subject_id: "sub-c" },
      { ...de, subject_id: "sub-d" }, // no region
      // A non-call event with a country is not a tool call.
      { ...de, region: "Hesse", subject_id: "sub-z", event_type: "connection" },
      // United States: only calls without a region.
      { country_code: "US", subject_id: "sub-e" },
      { country_code: "US", subject_id: "sub-e" },
      // France, from another platform.
      { country_code: "FR", region: "Île-de-France", subject_id: "sub-g", platform: "claude" },
      // No location: three calls without a user key, one with.
      { session_id: "x1" },
      { session_id: "x2" },
      { session_id: "x3", user_id: "" },
      { subject_id: "sub-f" },
      // Japan, outside the default range.
      { country_code: "JP", region: "Tokyo", subject_id: "sub-j", timestamp: day(-30) },
    ]);
    // Another project in the same workspace, and another workspace: invisible.
    await insert([{ ...de, region: "Bavaria", subject_id: "sub-o" }], {
      ws,
      project: `${project}-other`,
    });
    await insert([{ ...de, region: "Saxony", subject_id: "sub-w" }], {
      ws: `${ws}-other`,
      project,
    });
  });

  afterAll(async () => {
    await admin?.close();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });

  it("groups calls by country and region, Unknown buckets included", async () => {
    const r = await q.queryLocationBreakdown(ctx(day(-7), day(1)));
    expect(r.countries.map((c) => c.countryCode)).toEqual(["DE", "US", "FR"]);

    const [deRow, us, fr] = r.countries;
    expect(deRow.toolCalls).toBe(6);
    expect(deRow.regions).toEqual([
      { region: "North Rhine-Westphalia", toolCalls: 3, users: 2 },
      { region: "State of Berlin", toolCalls: 2, users: 2 },
      { region: null, toolCalls: 1, users: 1 },
    ]);
    expect(us).toEqual({
      countryCode: "US",
      toolCalls: 2,
      users: 1,
      regions: [{ region: null, toolCalls: 2, users: 1 }],
    });
    expect(fr.regions).toEqual([{ region: "Île-de-France", toolCalls: 1, users: 1 }]);
    // Calls without a key count as calls, not as users; no regions without a country.
    expect(r.unknown).toEqual({ toolCalls: 4, users: 1 });

    expect(r.totalToolCalls).toBe(13);
    expect(r.locatedToolCalls).toBe(9);
  });

  it("counts a country's users once, not summed from its regions", async () => {
    const r = await q.queryLocationBreakdown(ctx(day(-7), day(1)));
    const deRow = r.countries.find((c) => c.countryCode === "DE");
    // sub-a, bob (sub-b), sub-c, sub-d — the regions add up to 5.
    expect(deRow?.users).toBe(4);
    expect(deRow?.regions.reduce((sum, x) => sum + x.users, 0)).toBe(5);
  });

  it("applies the date range", async () => {
    const wide = await q.queryLocationBreakdown(ctx(day(-60), day(1)));
    expect(wide.countries.find((c) => c.countryCode === "JP")?.regions).toEqual([
      { region: "Tokyo", toolCalls: 1, users: 1 },
    ]);
    expect(wide.totalToolCalls).toBe(14);

    const empty = await q.queryLocationBreakdown(ctx(day(-90), day(-60)));
    expect(empty).toEqual({ totalToolCalls: 0, locatedToolCalls: 0, countries: [], unknown: null });
  });

  it("applies the platform filter", async () => {
    const r = await q.queryLocationBreakdown(ctx(day(-7), day(1), ["chatgpt"]));
    expect(r.countries.map((c) => c.countryCode)).toEqual(["DE", "US"]);
    expect(r.unknown).toEqual({ toolCalls: 4, users: 1 });
    expect(r.totalToolCalls).toBe(12);
    expect(r.locatedToolCalls).toBe(8);

    const claude = await q.queryLocationBreakdown(ctx(day(-7), day(1), ["claude"]));
    expect(claude.countries.map((c) => c.countryCode)).toEqual(["FR"]);
    expect(claude.unknown).toBeNull();
  });

  it("counts a second process's calls for the user their session identified (#145)", async () => {
    // Claude sends no subject_id: before the session stitch only the calls of
    // the process that ran identify() had a user.
    const fleet = { ws, project: `${project}-fleet` };
    await insert(
      [
        { event_type: "identify", event_name: null, user_id: "lea", session_id: "conv-lea" },
        { user_id: "lea", session_id: "conv-lea", country_code: "DE" },
        { session_id: "conv-lea", country_code: "FR" },
      ].map((r) => ({ ...r, platform: "claude" })),
      fleet,
    );
    const r = await q.queryLocationBreakdown({
      workspaceId: ws,
      projectId: fleet.project,
      from: day(-7),
      to: day(1),
    });
    const rows = r.countries.map((c) => [c.countryCode, c.toolCalls, c.users]);
    expect(rows.sort()).toEqual([
      ["DE", 1, 1],
      ["FR", 1, 1],
    ]);
  });

  it("sees nothing of another project or workspace", async () => {
    const r = await q.queryLocationBreakdown(ctx(day(-7), day(1)));
    const regions = r.countries.flatMap((c) => c.regions.map((x) => x.region));
    expect(regions).not.toContain("Bavaria");
    expect(regions).not.toContain("Saxony");

    const other = await q.queryLocationBreakdown({
      workspaceId: `${ws}-other`,
      projectId: project,
      from: day(-7),
      to: day(1),
    });
    expect(other.countries.map((c) => c.regions)).toEqual([
      [{ region: "Saxony", toolCalls: 1, users: 1 }],
    ]);
  });
});
