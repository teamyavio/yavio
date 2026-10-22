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

/** A cursor at `ingestedAt`, before any row of that stamp, with nothing read. */
function from(ingestedAt: string) {
  return { ingestedAt, eventId: "", seen: [], connections: [] };
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

  it("starts at ClickHouse's clock: a burst stored 50 minutes ago is not replayed on connect", async () => {
    const projectId = `p-${randomUUID().slice(0, 8)}`;
    const scope = { workspaceId: ws, projectId };
    const session = `s-${randomUUID().slice(0, 8)}`;
    const old = (ms: number) =>
      new Date(Date.now() - 50 * 60_000 + ms).toISOString().replace("T", " ").replace("Z", "");
    await insert(
      Array.from({ length: 20 }, (_, i) => ({
        project_id: projectId,
        session_id: session,
        event_name: `old-${i}`,
        timestamp: old(i * 100),
        ingested_at: old(i * 100 + 50),
      })),
    );
    const before = Date.now();
    const cursor = await q.initialLiveCursor(scope);
    const startedAt = Date.parse(`${cursor.ingestedAt.replace(" ", "T")}Z`);
    expect(startedAt).toBeGreaterThanOrEqual(before - 2_000);
    expect(startedAt).toBeLessThanOrEqual(Date.now() + 2_000);
    expect(cursor.seen).toEqual([]);
    // Review round 4 started at the newest ingested_at of the last hour,
    // against a skew between ingest's clock and ClickHouse's: every
    // (re)connect replayed the burst as live. ClickHouse stamps ingested_at
    // at insert now (round 5), so the clock is the start and the burst stays
    // in the past.
    const first = await q.pollLive(scope, cursor, undefined);
    expect(first.events).toEqual([]);
  });

  it("a row inserted 25 s after its event timestamp is found on connect — ingested_at is the insert time — and a late row is found after a jump", async () => {
    // The SDK's batching and retries, and the batch writer's own, put an
    // event's timestamp behind its insert by seconds; ClickHouse stamps
    // ingested_at when the row is stored (no value sent here, the column
    // DEFAULT), so it is inside the window the clock cursor opens.
    const projectId = `p-${randomUUID().slice(0, 8)}`;
    const scope = { workspaceId: ws, projectId };
    const session = `s-${randomUUID().slice(0, 8)}`;
    const behind = (ms: number) =>
      new Date(Date.now() - ms).toISOString().replace("T", " ").replace("Z", "");
    const cursor = await q.initialLiveCursor(scope);
    await insert([
      {
        project_id: projectId,
        session_id: session,
        event_name: "delayed",
        timestamp: behind(25_000),
      },
    ]);
    const first = await q.pollLive(scope, cursor, undefined);
    expect(first.events.map((e) => e.eventName)).toEqual(["delayed"]);
    const stamped = Date.parse(`${first.cursor.ingestedAt.replace(" ", "T")}Z`);
    expect(Math.abs(stamped - Date.now())).toBeLessThan(5_000);

    // After a jump, in a project of its own: a backlog beyond the cap two
    // minutes ago, then one row stored at −25 s. The jump lands on that row
    // (the newest of the last hour), not on the clock, whose window — the
    // last 10 s — did not hold it (review round 4).
    const later = behind(25_000);
    const projectB = `p-${randomUUID().slice(0, 8)}`;
    const scopeB = { workspaceId: ws, projectId: projectB };
    const far = (ms: number) => at(ms - 60_000);
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
        event_name: "late",
        timestamp: later,
        ingested_at: later,
      },
    ]);
    const capped = await q.pollLive(scopeB, from(far(0)), undefined);
    expect(capped.events).toHaveLength(500);
    expect(capped.cursor.ingestedAt).toBe(later);
    const next = await q.pollLive(scopeB, capped.cursor, undefined);
    expect(next.events.map((e) => e.eventName)).toEqual(["late"]);
  });

  it("a row whose timestamp is three hours behind its ingested_at — a host with a slow clock — is shown live", async () => {
    // Ingest clamps a client timestamp to [now − 72 h, now + 5 min], so the
    // events of a host whose clock runs hours slow are stored with their
    // old timestamps. Review round 4's bound — timestamp within an hour
    // before the cursor, standing in for an index on ingested_at — hid
    // every one of them; with the minmax skip index (migration 0021) the
    // poll prunes by ingested_at itself and the bound is gone.
    const projectId = `p-${randomUUID().slice(0, 8)}`;
    const scope = { workspaceId: ws, projectId };
    const session = `s-${randomUUID().slice(0, 8)}`;
    const cursor = await q.initialLiveCursor(scope);
    const behind = new Date(Date.now() - 3 * 3_600_000)
      .toISOString()
      .replace("T", " ")
      .replace("Z", "");
    await insert([
      { project_id: projectId, session_id: session, event_name: "slow-clock", timestamp: behind },
    ]);
    const { events } = await q.pollLive(scope, cursor, undefined);
    expect(events.map((e) => e.eventName)).toEqual(["slow-clock"]);
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
    const { events } = await q.pollLive(ctx, from(at(0)), undefined);
    const ofSession = events.filter((e) => e.sessionId === session);
    expect(ofSession.map((e) => e.eventType)).toEqual(["connection", "tool_call"]);
    expect(ofSession[0]?.timestamp.startsWith(at(0).slice(0, 19))).toBe(true); // the earliest
    // Filtered to connections: the same one row; to tool calls: none of them.
    const only = await q.pollLive(ctx, from(at(0)), "connection");
    expect(only.events.filter((e) => e.sessionId === session).map((e) => e.eventId)).toEqual([
      ofSession[0]?.eventId,
    ]);
    const calls = await q.pollLive(ctx, from(at(0)), "tool_call");
    expect(calls.events.filter((e) => e.sessionId === session).map((e) => e.eventType)).toEqual([
      "tool_call",
    ]);
  });

  it("two connection rows of one session in one insert block, split by the page cap across two polls, give one connection", async () => {
    // One block: a connection row that sorts first, 550 tool calls, and a
    // second connection row of the same session that sorts last — the page
    // cap (500) puts them in different polls. Before review round 6 both
    // passed the query's `(session_id, min(ingested_at))` filter (one
    // stamp), and the per-poll check could not tell.
    const projectId = `p-${randomUUID().slice(0, 8)}`;
    const scope = { workspaceId: ws, projectId };
    const session = `s-${randomUUID().slice(0, 8)}`;
    const firstId = `0000-${randomUUID()}`;
    const lastId = `ffff-${randomUUID()}`;
    await insert([
      {
        event_id: firstId,
        event_type: "connection",
        event_name: null,
        project_id: projectId,
        session_id: session,
        timestamp: at(20_000),
        ingested_at: at(30_000),
      },
      ...Array.from({ length: 550 }, (_, i) => ({
        project_id: projectId,
        session_id: session,
        event_name: `call-${i}`,
        timestamp: at(20_000 + i * 10),
        ingested_at: at(30_000),
      })),
      {
        event_id: lastId,
        event_type: "connection",
        event_name: null,
        project_id: projectId,
        session_id: session,
        timestamp: at(21_000),
        ingested_at: at(30_000),
      },
    ]);
    const first = await q.pollLive(scope, from(at(25_000)), undefined);
    const second = await q.pollLive(scope, first.cursor, undefined);
    const connections = [...first.events, ...second.events].filter(
      (e) => e.eventType === "connection",
    );
    expect(connections.map((e) => e.eventId)).toEqual([firstId]);
    expect(first.events.length + second.events.length).toBe(551);
  });

  it("an earlier connection row of a session in a block visible after the session's connection was shown is not a second connection", async () => {
    // Poll 1 shows the session's connection (block +5 s). Then a block
    // stamped +1 s becomes visible (an insert that took longer) with an
    // earlier connection row of the same session: it is the session's
    // earliest now and passes the query; the cursor remembers the session
    // for the window and it is not shown again.
    const projectId = `p-${randomUUID().slice(0, 8)}`;
    const scope = { workspaceId: ws, projectId };
    const session = `s-${randomUUID().slice(0, 8)}`;
    await insert([
      {
        event_type: "connection",
        event_name: null,
        project_id: projectId,
        session_id: session,
        timestamp: at(4_000),
        ingested_at: at(5_000),
      },
    ]);
    const first = await q.pollLive(scope, from(at(0)), undefined);
    expect(first.events.map((e) => e.eventType)).toEqual(["connection"]);
    await insert([
      {
        event_type: "connection",
        event_name: null,
        project_id: projectId,
        session_id: session,
        timestamp: at(0),
        ingested_at: at(1_000),
      },
      {
        project_id: projectId,
        session_id: session,
        event_name: "after",
        timestamp: at(6_000),
        ingested_at: at(7_000),
      },
    ]);
    const second = await q.pollLive(scope, first.cursor, undefined);
    expect(second.events.map((e) => e.eventType)).toEqual(["tool_call"]);
  });

  it("a 1 200-row insert block with one ingested_at is walked out over three polls, nothing twice: the cursor is a position inside the block", async () => {
    // Before review round 6 the cursor was the stamp alone: it sat still
    // inside such a block, and the pages could only walk it by listing
    // every id read so far in the query — the whole block in the end, with
    // every page.
    const projectId = `p-${randomUUID().slice(0, 8)}`;
    const scope = { workspaceId: ws, projectId };
    const session = `s-${randomUUID().slice(0, 8)}`;
    const ids = Array.from({ length: 1_200 }, () => randomUUID()).sort();
    await insert(
      ids.map((event_id, i) => ({
        event_id,
        project_id: projectId,
        session_id: session,
        event_name: `call-${i}`,
        timestamp: at(20_000 + i * 10),
        ingested_at: at(30_000),
      })),
    );
    const first = await q.pollLive(scope, from(at(25_000)), undefined);
    expect(first.events).toHaveLength(500);
    expect(first.cursor.ingestedAt).toBe(at(30_000));
    expect(first.cursor.eventId).toBe(ids[499]);
    expect(first.cursor.resume).toBeUndefined();
    const second = await q.pollLive(scope, first.cursor, undefined);
    expect(second.events).toHaveLength(500);
    expect(second.cursor.eventId).toBe(ids[999]);
    const third = await q.pollLive(scope, second.cursor, undefined);
    expect(third.events).toHaveLength(200);
    expect(third.cursor.eventId).toBe(ids[1_199]);
    const fourth = await q.pollLive(scope, third.cursor, undefined);
    expect(fourth.events).toEqual([]);
    const shown = [...first.events, ...second.events, ...third.events].map((e) => e.eventId);
    expect(new Set(shown).size).toBe(1_200);
    expect(shown).toEqual(ids);
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
    const first = await q.pollLive(scope, from(at(25_000)), undefined);
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
    const first = await q.pollLive(scope, from(far(0)), undefined);
    expect(first.events).toHaveLength(500);
    expect(first.events[499]?.eventName).toBe("call-499");
    // The jump: to the newest row of the last hour (69.9 s) — not to the
    // last page read (49.9 s), and not to ClickHouse's clock (review round
    // 3), which ingest's clock may run behind by more than the overlap.
    expect(first.cursor.ingestedAt).toBe(far(69_900));
    // The cursor remembers every row read — all within the 200 s resend
    // horizon of this read — and the next query leaves out only the blocks
    // of the window (the 10 s before 69.9 s): none of them.
    expect(first.cursor.seen).toHaveLength(500);

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

  it("an SDK resend stored 64 s later — a second row for the same event_id with a newer ingested_at, the cursor having moved on twice meanwhile — is not shown again", async () => {
    // The SDK re-sends a batch whose fetch timed out or saw a 5xx after
    // ingest had written it, after each 30 s fetch timeout plus a backoff:
    // at about 31 s and again at 63 s; the resend is a second row until a
    // merge collapses it. Merges off, so the second row is there to be
    // found. Review round 5 remembered a row for 60 s of the CURSOR's
    // stamp: once the cursor stood 63 s past the row's block, the row was
    // forgotten and the resend at 64 s was shown again (round 6).
    const projectId = `p-${randomUUID().slice(0, 8)}`;
    const scope = { workspaceId: ws, projectId };
    const session = `s-${randomUUID().slice(0, 8)}`;
    const resent = randomUUID();
    await admin.command({ query: "SYSTEM STOP MERGES events" });
    try {
      await insert([
        {
          event_id: resent,
          project_id: projectId,
          session_id: session,
          event_name: "once",
          timestamp: at(0),
          ingested_at: at(100),
        },
      ]);
      const first = await q.pollLive(scope, from(at(0)), undefined);
      expect(first.events.map((e) => e.eventName)).toEqual(["once"]);
      // Two more rows move the cursor on, to 63 s past the first row's block.
      await insert([
        {
          project_id: projectId,
          session_id: session,
          event_name: "next",
          timestamp: at(30_000),
          ingested_at: at(31_100),
        },
      ]);
      const second = await q.pollLive(scope, first.cursor, undefined);
      expect(second.events.map((e) => e.eventName)).toEqual(["next"]);
      expect(second.cursor.ingestedAt).toBe(at(31_100));
      await insert([
        {
          project_id: projectId,
          session_id: session,
          event_name: "later",
          timestamp: at(62_000),
          ingested_at: at(63_100),
        },
      ]);
      const third = await q.pollLive(scope, second.cursor, undefined);
      expect(third.events.map((e) => e.eventName)).toEqual(["later"]);
      // The resend: the same event_id and timestamp, stored 64 s after the
      // first row.
      await insert([
        {
          event_id: resent,
          project_id: projectId,
          session_id: session,
          event_name: "once",
          timestamp: at(0),
          ingested_at: at(64_100),
        },
      ]);
      const fourth = await q.pollLive(scope, third.cursor, undefined);
      expect(fourth.events).toEqual([]);
      expect(fourth.cursor.ingestedAt).toBe(at(64_100));
    } finally {
      await admin.command({ query: "SYSTEM START MERGES events" });
    }
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
    const first = await q.pollLive(ctx, from(at(5_000)), undefined);
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
