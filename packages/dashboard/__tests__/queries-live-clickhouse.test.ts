import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_TEST_PASSWORD,
  adminClient,
  applyMigrations,
  clickhouseUrl,
} from "./helpers/clickhouse";

// #148: the live feed on a real ClickHouse, as yavio_dashboard. A stateless
// fleet gives a session one `connection` row per instance that served it,
// and an instance whose 10 s batch lands after a newer event from another
// instance has an older `timestamp` with a newer `ingested_at` — which a
// feed tailing by `timestamp` skipped for good. In production ClickHouse
// stamps `ingested_at` at insert from the column DEFAULT (#148 review round
// 5); the rows here set it explicitly where a test stages a timeline, and
// leave it out where the point is the insert-time stamp.

const url = clickhouseUrl();

type Live = typeof import("@/lib/queries/live");
let q: Live;
let admin: ClickHouseClient;

const ws = `ws-${randomUUID().slice(0, 8)}`;
const project = `p-${randomUUID().slice(0, 8)}`;
const ctx = { workspaceId: ws, projectId: project };

/** `YYYY-MM-DD HH:MM:SS.mmm` (UTC), `offsetMs` from a fixed base a minute in the past. */
const base = Date.now() - 60_000;
function at(offsetMs: number): string {
  return new Date(base + offsetMs).toISOString().replace("T", " ").replace("Z", "");
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

describe.skipIf(!url)("live feed on a real ClickHouse (#148)", () => {
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
    q = await import("@/lib/queries/live");
  });

  afterAll(async () => {
    process.env.CLICKHOUSE_URL = savedEnv.CLICKHOUSE_URL;
    process.env.CLICKHOUSE_DASHBOARD_PASSWORD = savedEnv.CLICKHOUSE_DASHBOARD_PASSWORD;
    await admin.close();
  });

  it("starts at ClickHouse's clock when the project has no recent rows", async () => {
    const before = Date.now();
    const cursor = await q.initialLiveCursor(ctx); // nothing inserted for this project yet
    const startedAt = Date.parse(`${cursor.ingestedAt.replace(" ", "T")}Z`);
    expect(startedAt).toBeGreaterThanOrEqual(before - 2_000);
    expect(startedAt).toBeLessThanOrEqual(Date.now() + 2_000);
    expect(cursor.seen).toEqual([]);
  });

  it("a row stamped 25 s behind ClickHouse's clock — ingest's clock, not ClickHouse's — is found on connect and after a jump", async () => {
    // ingested_at is stamped by the ingest process; a skew between its
    // clock and ClickHouse's larger than the 10 s overlap hid every row for
    // good when the cursor came from the clock (#148 review round 4).
    const projectId = `p-${randomUUID().slice(0, 8)}`;
    const scope = { workspaceId: ws, projectId };
    const session = `s-${randomUUID().slice(0, 8)}`;
    const behind = (ms: number) =>
      new Date(Date.now() - ms).toISOString().replace("T", " ").replace("Z", "");
    const skewed = behind(25_000);
    await insert([
      {
        project_id: projectId,
        session_id: session,
        event_name: "skewed",
        timestamp: skewed,
        ingested_at: skewed,
      },
    ]);
    // On connect: the cursor is the newest ingested_at, so the first
    // window holds the row. Before the fix the cursor was the clock minus
    // the overlap, the window 20 s: the row at −25 s was never shown.
    const cursor = await q.initialLiveCursor(scope);
    const first = await q.pollLive(scope, cursor, undefined);
    expect(first.events.map((e) => e.eventName)).toEqual(["skewed"]);
    expect(cursor.ingestedAt).toBe(skewed);

    // After a jump, in a project of its own: a backlog beyond the cap two
    // minutes ago, then one row at −25 s. The jump lands on that row (the
    // newest of the last hour), not on the clock, whose window — the last
    // 10 s — did not hold it.
    const projectB = `p-${randomUUID().slice(0, 8)}`;
    const scopeB = { workspaceId: ws, projectId: projectB };
    const far = (ms: number) => at(ms - 60_000);
    const later = behind(25_000);
    await insert([
      ...Array.from({ length: 600 }, (_, i) => ({
        project_id: projectB,
        session_id: session,
        event_name: `call-${i}`,
        timestamp: far(i * 100 - 50),
        ingested_at: far(i * 100),
      })),
      {
        project_id: projectB,
        session_id: session,
        event_name: "skewed-2",
        timestamp: later,
        ingested_at: later,
      },
    ]);
    const capped = await q.pollLive(scopeB, { ingestedAt: far(0), seen: [] }, undefined);
    expect(capped.events).toHaveLength(500);
    expect(capped.cursor.ingestedAt).toBe(later);
    const next = await q.pollLive(scopeB, capped.cursor, undefined);
    expect(next.events.map((e) => e.eventName)).toEqual(["skewed-2"]);
  });

  it("two instances' rows for one session give one connection row", async () => {
    const session = `s-${randomUUID().slice(0, 8)}`;
    await insert([
      {
        event_type: "connection",
        event_name: null,
        session_id: session,
        timestamp: at(0),
        ingested_at: at(100),
      },
      {
        event_type: "connection",
        event_name: null,
        session_id: session,
        timestamp: at(1_000),
        ingested_at: at(1_100),
      },
      { session_id: session, timestamp: at(2_000), ingested_at: at(2_100) },
    ]);
    const { events } = await q.pollLive(ctx, { ingestedAt: at(0), seen: [] }, undefined);
    const ofSession = events.filter((e) => e.sessionId === session);
    expect(ofSession.map((e) => e.eventType)).toEqual(["connection", "tool_call"]);
    expect(ofSession[0]?.timestamp.startsWith(at(0).slice(0, 19))).toBe(true); // the earliest
    // Filtered to connections: the same one row; to tool calls: none of them.
    const only = await q.pollLive(ctx, { ingestedAt: at(0), seen: [] }, "connection");
    expect(only.events.filter((e) => e.sessionId === session).map((e) => e.eventId)).toEqual([
      ofSession[0]?.eventId,
    ]);
    const calls = await q.pollLive(ctx, { ingestedAt: at(0), seen: [] }, "tool_call");
    expect(calls.events.filter((e) => e.sessionId === session).map((e) => e.eventType)).toEqual([
      "tool_call",
    ]);
  });

  it("a 100-row batch with one ingested_at is shown in full in one poll, nothing twice", async () => {
    // Ingest stamps one ingested_at on a request batch, and the SDK sends
    // up to 100 events per batch. Its own project: the pages must hold only
    // this batch.
    const projectId = `p-${randomUUID().slice(0, 8)}`;
    const scope = { workspaceId: ws, projectId };
    const session = `s-${randomUUID().slice(0, 8)}`;
    await insert(
      Array.from({ length: 100 }, (_, i) => ({
        project_id: projectId,
        session_id: session,
        event_name: `call-${i}`,
        timestamp: at(20_000 + i * 10),
        ingested_at: at(30_000),
      })),
    );
    // Round 1: the page was the 50 newest by timestamp, the cursor moved to
    // the batch's ingested_at, and the next poll ranked the same 50 first
    // again — the other 50 never showed. Round 2: one poll walks the pages
    // (two full ones, then an empty one) instead of one page per poll.
    const first = await q.pollLive(scope, { ingestedAt: at(25_000), seen: [] }, undefined);
    expect(first.events).toHaveLength(100);
    expect(new Set(first.events.map((e) => e.eventId)).size).toBe(100);
    expect(first.cursor.ingestedAt).toBe(at(30_000));
    expect(first.cursor.seen).toHaveLength(100);
    const second = await q.pollLive(scope, first.cursor, undefined);
    expect(second.events).toEqual([]);
    expect(second.cursor.ingestedAt).toBe(at(30_000));
  });

  it("a backlog beyond the cap is given up: 700 rows over 70 s show the first 500, then the cursor jumps to the newest row and the rows before its window never show", async () => {
    const projectId = `p-${randomUUID().slice(0, 8)}`;
    const scope = { workspaceId: ws, projectId };
    const session = `s-${randomUUID().slice(0, 8)}`;
    // One row every 100 ms, two minutes ago — all of it older than the
    // window the jump opens: the cap (10 pages of 50) covers the first 50 s.
    const far = (ms: number) => at(ms - 60_000);
    await insert(
      Array.from({ length: 700 }, (_, i) => ({
        project_id: projectId,
        session_id: session,
        event_name: `call-${i}`,
        timestamp: far(i * 100 - 50),
        ingested_at: far(i * 100),
      })),
    );
    const first = await q.pollLive(scope, { ingestedAt: far(0), seen: [] }, undefined);
    expect(first.events).toHaveLength(500);
    expect(first.events[499]?.eventName).toBe("call-499");
    // The jump: to the newest row of the last hour (69.9 s) — not to the
    // last page read (49.9 s), and not to ClickHouse's clock (review round
    // 3), which ingest's clock may run behind by more than the overlap.
    expect(first.cursor.ingestedAt).toBe(far(69_900));
    // `seen` keeps only the rows read inside the new window: none.
    expect(first.cursor.seen).toHaveLength(0);

    // The next poll reads the window the jump opened — the 10 s before the
    // newest row — rows 599–699; rows 500–598 are never shown.
    const second = await q.pollLive(scope, first.cursor, undefined);
    expect(second.events.map((e) => e.eventName)).toEqual(
      Array.from({ length: 101 }, (_, i) => `call-${599 + i}`),
    );
    expect(second.cursor.ingestedAt).toBe(far(69_900));

    // A row ingested now is shown: the feed is live again.
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    await insert([
      {
        project_id: projectId,
        session_id: session,
        event_name: "call-fresh",
        timestamp: now,
        ingested_at: now,
      },
    ]);
    const third = await q.pollLive(scope, second.cursor, undefined);
    expect(third.events.map((e) => e.eventName)).toEqual(["call-fresh"]);
    expect(third.cursor.ingestedAt).toBe(now);
  });

  it("interleaved batches skip nothing across two polls: an older-timestamp event ingested later is shown once", async () => {
    const session = `s-${randomUUID().slice(0, 8)}`;
    // Instance A's event: timestamp +15 s, ingested at +16 s.
    await insert([
      {
        session_id: session,
        event_name: "from-a",
        timestamp: at(15_000),
        ingested_at: at(16_000),
      },
    ]);
    const first = await q.pollLive(ctx, { ingestedAt: at(5_000), seen: [] }, undefined);
    expect(first.events.filter((e) => e.sessionId === session).map((e) => e.eventName)).toEqual([
      "from-a",
    ]);
    expect(first.cursor.ingestedAt).toBe(at(16_000));

    // Instance B's 10 s batch lands afterwards: an OLDER timestamp (+12 s)
    // with a NEWER ingested_at (+18 s). A feed tailing by timestamp — its
    // cursor already at +15 s — never showed it.
    await insert([
      {
        session_id: session,
        event_name: "from-b",
        timestamp: at(12_000),
        ingested_at: at(18_000),
      },
    ]);
    const second = await q.pollLive(ctx, first.cursor, undefined);
    const names = second.events.filter((e) => e.sessionId === session).map((e) => e.eventName);
    expect(names).toEqual(["from-b"]); // and not from-a again
    expect(second.cursor.ingestedAt).toBe(at(18_000));

    // A third poll with nothing new shows nothing, and the cursor stays.
    const third = await q.pollLive(ctx, second.cursor, undefined);
    expect(third.events.filter((e) => e.sessionId === session)).toEqual([]);
    expect(third.cursor.ingestedAt).toBe(at(18_000));
  });
});
