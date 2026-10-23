import { randomUUID } from "node:crypto";
import type { ClickHouseClient, ClickHouseSettings } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_TEST_PASSWORD,
  adminClient,
  applyMigrations,
  clickhouseUrl,
} from "./helpers/clickhouse";

// #145: funnels on a real ClickHouse, as yavio_dashboard. step_sequence is
// the SDK's counter per session per process, so a conversation served by
// several instances restarted at 1 on each; positions are now the order of
// the session's steps in time. A single process must give exactly what the
// old grouping by step_sequence gave.

const url = clickhouseUrl();

type Funnels = typeof import("@/lib/queries/funnels");
type Client = typeof import("@/lib/clickhouse/analytics-client");
let q: Funnels;
let client: Client;
let admin: ClickHouseClient;

const ws = `ws-${randomUUID().slice(0, 8)}`;

/** `YYYY-MM-DD HH:MM:SS.mmm` (UTC), `offsetMs` from a fixed base two days ago. */
const base = Date.now() - 2 * 86_400_000;
function at(offsetMs: number): string {
  return new Date(base + offsetMs).toISOString().replace("T", " ").replace("Z", "");
}
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface Step {
  session: string;
  seq: number;
  name: string;
  ms: number;
  trace?: string;
  id?: string;
}

async function insertSteps(
  projectId: string,
  steps: Step[],
  settings: ClickHouseSettings = {},
): Promise<void> {
  await admin.insert({
    table: "events",
    values: steps.map((s) => ({
      event_id: s.id ?? randomUUID(),
      workspace_id: ws,
      project_id: projectId,
      trace_id: s.trace ?? `t-${s.session}-${s.seq}`,
      session_id: s.session,
      event_type: "step",
      event_name: s.name,
      step_sequence: s.seq,
      timestamp: at(s.ms),
      source: "server",
    })),
    format: "JSONEachRow",
    clickhouse_settings: settings,
  });
}

const range = (projectId: string, fromMs: number, toMs: number) => ({
  workspaceId: ws,
  projectId,
  from: at(fromMs),
  to: at(toMs),
});

/** The progression query before #145, verbatim, and its mapping. */
async function oldProgression(ctx: ReturnType<typeof range>) {
  const rows = await client.queryAnalytics<{
    stepSequence: number;
    eventName: string;
    traceCount: number;
  }>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT
        step_sequence AS stepSequence,
        event_name AS eventName,
        uniqExact(trace_id) AS traceCount
      FROM events
      WHERE project_id = {projectId:String}
        AND event_type IN ('step', 'conversion')
        AND step_sequence IS NOT NULL
        AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
      GROUP BY stepSequence, eventName
      ORDER BY stepSequence
    `,
    params: { projectId: ctx.projectId, from: ctx.from, to: ctx.to },
  });
  if (rows.length === 0) return [];
  const maxCount = Math.max(...rows.map((r) => Number(r.traceCount)));
  return rows.map((r) => ({
    stepSequence: Number(r.stepSequence),
    eventName: r.eventName,
    count: Number(r.traceCount),
    dropOffPercent: maxCount > 0 ? 1 - Number(r.traceCount) / maxCount : 0,
  }));
}

const sorted = <T extends { stepSequence: number; eventName: string }>(rows: T[]) =>
  [...rows].sort(
    (a, b) => a.stepSequence - b.stepSequence || a.eventName.localeCompare(b.eventName),
  );
const compact = (rows: Array<{ stepSequence: number; eventName: string; count: number }>) =>
  sorted(rows).map((r) => `${r.stepSequence} ${r.eventName} ${r.count}`);

describe.skipIf(!url)("funnels on a real ClickHouse (#145)", () => {
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
    q = await import("@/lib/queries/funnels");
    client = await import("@/lib/clickhouse/analytics-client");
  });

  afterAll(async () => {
    await admin?.close();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });

  describe("a single process gives the same funnel as before", () => {
    const projectId = `p-single-${randomUUID().slice(0, 8)}`;

    beforeAll(async () => {
      const steps: Step[] = [];
      // Twelve conversations, each on one process: start → search → (book |
      // compare → book) → pay, of different lengths, several steps of a
      // conversation sometimes in one trace (one tool call).
      for (let i = 0; i < 12; i++) {
        const names =
          i % 3 === 0
            ? ["start", "search", "compare", "book", "pay"]
            : ["start", "search", "book", "pay"];
        const length = 1 + (i % names.length);
        for (let k = 0; k < length; k++) {
          steps.push({
            session: `single-${i}`,
            seq: k + 1,
            name: names[k],
            ms: i * 10 * MIN + k * MIN,
            trace: i % 4 === 0 ? `t-single-${i}` : undefined,
          });
        }
      }
      // A conversation that straddles the start of the cut range below.
      steps.push(
        { session: "straddle", seq: 1, name: "start", ms: -2 * HOUR },
        { session: "straddle", seq: 2, name: "search", ms: -HOUR },
        { session: "straddle", seq: 3, name: "renew", ms: HOUR },
        { session: "straddle", seq: 4, name: "confirm", ms: 2 * HOUR },
      );
      // Two steps in the same millisecond, the later one with the smaller
      // event_id: step_sequence, not event_id, keeps them in order.
      steps.push(
        { session: "same-ms", seq: 1, name: "start", ms: 3 * HOUR },
        {
          session: "same-ms",
          seq: 2,
          name: "search",
          ms: 3 * HOUR + MIN,
          id: "ffffffff-0000-4000-8000-000000000000",
        },
        {
          session: "same-ms",
          seq: 3,
          name: "book",
          ms: 3 * HOUR + MIN,
          id: "00000000-0000-4000-8000-000000000000",
        },
      );
      // Steps without a session (no SDK writes one) keep the old rule.
      steps.push(
        { session: "", seq: 1, name: "start", ms: 4 * HOUR, trace: "t-nosession-1" },
        { session: "", seq: 3, name: "book", ms: 4 * HOUR + MIN, trace: "t-nosession-2" },
      );
      await insertSteps(projectId, steps);
    });

    it("over a range that holds every step", async () => {
      const ctx = range(projectId, -3 * HOUR, 30 * HOUR);
      const now = await q.queryFunnelProgression(ctx);
      expect(sorted(now)).toEqual(sorted(await oldProgression(ctx)));
      expect(now.length).toBeGreaterThan(5);
    });

    it("over a range that cuts a conversation: its later steps keep their positions", async () => {
      const ctx = range(projectId, 0, 30 * HOUR);
      const now = await q.queryFunnelProgression(ctx);
      expect(sorted(now)).toEqual(sorted(await oldProgression(ctx)));
      // The straddling conversation's renew and confirm are steps 3 and 4,
      // although its first two steps are outside the range.
      expect(compact(now)).toEqual(expect.arrayContaining(["3 renew 1", "4 confirm 1"]));
    });

    it("over a range that starts at a same-millisecond pair", async () => {
      const ctx = range(projectId, 3 * HOUR + MIN, 30 * HOUR);
      const now = await q.queryFunnelProgression(ctx);
      expect(sorted(now)).toEqual(sorted(await oldProgression(ctx)));
      expect(compact(now)).toEqual(["1 start 1", "2 search 1", "3 book 2"]);
    });
  });

  it("ranks with steps up to 30 days before the range: one 29 days before counts, one 31 days before does not (review round 1)", async () => {
    // Unbounded, the rank read every step the project ever stored before
    // the range's end. A conversation that began more than 30 days before
    // the range start is renumbered from its first step inside the bound.
    const projectId = `p-lookback-${randomUUID().slice(0, 8)}`;
    await insertSteps(projectId, [
      { session: "recent", seq: 1, name: "start", ms: -29 * DAY },
      { session: "recent", seq: 2, name: "search", ms: HOUR },
      { session: "recent", seq: 3, name: "book", ms: 2 * HOUR },
      { session: "old", seq: 1, name: "start", ms: -31 * DAY },
      { session: "old", seq: 2, name: "search", ms: HOUR },
      { session: "old", seq: 3, name: "book", ms: 2 * HOUR },
    ]);
    const steps = await q.queryFunnelProgression(range(projectId, 0, DAY));
    expect(compact(steps)).toEqual(["1 search 1", "2 book 1", "2 search 1", "3 book 1"]);
  });

  it("counts a conversation served by two instances as one attempt, its steps in time order", async () => {
    // Instance A records start and search; instance B, which never saw the
    // conversation before, records book with its own counter at 1.
    const projectId = `p-fleet-${randomUUID().slice(0, 8)}`;
    await insertSteps(projectId, [
      { session: "conv", seq: 1, name: "start", ms: 0 },
      { session: "conv", seq: 2, name: "search", ms: MIN },
      { session: "conv", seq: 1, name: "book", ms: 2 * MIN },
    ]);
    const steps = await q.queryFunnelProgression(range(projectId, -HOUR, HOUR));
    expect(compact(steps)).toEqual(["1 start 1", "2 search 1", "3 book 1"]);
  });

  it("neither double-counts nor shifts positions for a step stored twice", async () => {
    const projectId = `p-dup-${randomUUID().slice(0, 8)}`;
    const search: Step = { session: "conv", seq: 2, name: "search", ms: MIN, id: randomUUID() };
    // events is a ReplacingMergeTree: merges stay off until the query, or a
    // background merge would collapse the copies first.
    await admin.command({ query: "SYSTEM STOP MERGES events" });
    try {
      await insertSteps(projectId, [
        { session: "conv", seq: 1, name: "start", ms: 0 },
        search,
        { session: "conv", seq: 1, name: "book", ms: 2 * MIN },
      ]);
      // The same row again, past insert deduplication (an SDK retry of a
      // batch whose first insert went through).
      await insertSteps(projectId, [search], { insert_deduplicate: 0 });
      const raw = await admin.query({
        query: "SELECT count() AS n FROM events WHERE project_id = {p:String}",
        query_params: { p: projectId },
        format: "JSONEachRow",
      });
      expect(Number((await raw.json<{ n: string }>())[0].n)).toBe(4);
      const steps = await q.queryFunnelProgression(range(projectId, -HOUR, HOUR));
      expect(compact(steps)).toEqual(["1 start 1", "2 search 1", "3 book 1"]);
    } finally {
      await admin.command({ query: "SYSTEM START MERGES events" });
    }
  });

  it("counts drop-offs by conversation, not by trace", async () => {
    // "went-on" continued on another instance after search; "stopped" did
    // not. Only "stopped" dropped off at 2.
    const projectId = `p-drop-${randomUUID().slice(0, 8)}`;
    await insertSteps(projectId, [
      { session: "went-on", seq: 1, name: "start", ms: 0 },
      { session: "went-on", seq: 2, name: "search", ms: MIN },
      { session: "went-on", seq: 1, name: "book", ms: 2 * MIN },
      { session: "stopped", seq: 1, name: "start", ms: 3 * MIN },
      { session: "stopped", seq: 2, name: "search", ms: 4 * MIN },
    ]);
    const ctx = range(projectId, -HOUR, HOUR);
    expect(await q.queryDropOffTraces(ctx, 2)).toEqual(["t-stopped-2"]);
    expect(await q.queryDropOffTraces(ctx, 3)).toEqual(["t-went-on-1"]);
    expect(await q.queryDropOffTraces(ctx, 1)).toEqual([]);
  });

  it("orders a trace's timeline by time, then step_sequence", async () => {
    const projectId = `p-timeline-${randomUUID().slice(0, 8)}`;
    await insertSteps(projectId, [
      {
        session: "conv",
        seq: 1,
        name: "start",
        ms: 0,
        trace: "t-one",
        id: "ffffffff-0000-4000-8000-000000000000",
      },
      {
        session: "conv",
        seq: 2,
        name: "search",
        ms: 0,
        trace: "t-one",
        id: "00000000-0000-4000-8000-000000000000",
      },
    ]);
    const timeline = await q.queryTraceTimeline(range(projectId, -HOUR, HOUR), "t-one");
    expect(timeline.map((e) => e.eventName)).toEqual(["start", "search"]);
  });
});
