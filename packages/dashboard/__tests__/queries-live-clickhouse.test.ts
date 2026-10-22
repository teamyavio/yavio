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
// feed tailing by `timestamp` skipped for good. `ingested_at` is set
// explicitly on insert here, the way ingest sets it on receipt.

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

  it("starts one overlap window before ClickHouse's clock", async () => {
    const before = Date.now();
    const cursor = await q.initialLiveCursor(ctx);
    const startedAt = Date.parse(`${cursor.ingestedAt.replace(" ", "T")}Z`);
    expect(startedAt).toBeGreaterThanOrEqual(before - 10_000 - 2_000);
    expect(startedAt).toBeLessThanOrEqual(Date.now() - 10_000 + 2_000);
    expect(cursor.seen).toEqual([]);
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
  });

  it("a 100-row batch with one ingested_at is shown in full over two polls, nothing twice", async () => {
    // Ingest stamps one ingested_at on a request batch, and the SDK sends
    // up to 100 events per batch. Its own project: the page must hold only
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
    const first = await q.pollLive(scope, { ingestedAt: at(25_000), seen: [] }, undefined);
    expect(first.events).toHaveLength(50);
    expect(first.cursor.ingestedAt).toBe(at(30_000));
    // Before the fix the page was the 50 newest by timestamp, the cursor
    // moved to the batch's ingested_at, and the next poll ranked the same
    // 50 first again: the other 50 never showed, and after the overlap
    // window they were gone for good.
    const second = await q.pollLive(scope, first.cursor, undefined);
    expect(second.events).toHaveLength(50);
    const ids = new Set([...first.events, ...second.events].map((e) => e.eventId));
    expect(ids.size).toBe(100);
    expect(second.cursor.ingestedAt).toBe(at(30_000));
    const third = await q.pollLive(scope, second.cursor, undefined);
    expect(third.events).toEqual([]);
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
