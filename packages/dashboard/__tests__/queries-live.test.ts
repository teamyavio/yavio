import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockQueryAnalytics = vi.fn();

vi.mock("@/lib/clickhouse/analytics-client", () => ({
  queryAnalytics: (...args: unknown[]) => mockQueryAnalytics(...args),
}));

import {
  LIVE_MAX_PAGES,
  LIVE_PAGE,
  LIVE_RESEND_HORIZON_SECONDS,
  LIVE_SEEN_CAP,
  LIVE_SKEW_ALLOWANCE_SECONDS,
  LIVE_STAMPS_CAP,
  initialLiveCursor,
  pollLive,
} from "@/lib/queries/live";

const ctx = { workspaceId: "ws_1", projectId: "proj_1" };

function row(overrides: Record<string, unknown>) {
  return {
    eventId: "e",
    eventType: "tool_call",
    eventName: "search",
    timestamp: "2025-01-01 12:00:00.000",
    sessionId: "s1",
    traceId: "t1",
    userId: null,
    platform: "cursor",
    status: "success",
    latencyMs: 100,
    errorCategory: null,
    errorMessage: null,
    ingestedAt: "2025-01-01 12:00:00.000",
    ...overrides,
  };
}

const cursor = { ingestedAt: "2025-01-01 12:00:00.000", eventId: "", seen: [], connections: [] };

/** `n` rows of one insert block: one `ingested_at` for all of them (ClickHouse stamps the block). */
function batch(n: number, ingestedAt: string) {
  return Array.from({ length: n }, (_, i) =>
    row({ eventId: `b${String(i).padStart(4, "0")}`, ingestedAt }),
  );
}

type Row = ReturnType<typeof row>;
type Call = { query: string; params: Record<string, unknown> };

/**
 * A table of rows that answers the feed's queries the way ClickHouse would:
 * the window before the cursor, the walk's lower bound, the blocks left
 * out (`stamps`), the ids left out (`seen`, the query before review round
 * 6), the page limit, oldest first — and the jump query with the newest
 * position (in both shapes).
 */
function table(rows: Row[]) {
  const ms = (t: string) => Date.parse(`${t.replace(" ", "T")}Z`);
  const key = (r: { ingestedAt: string; eventId: string }) => `${r.ingestedAt}\u0000${r.eventId}`;
  const sorted = [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return async ({ query, params }: Call) => {
    if (query.includes("maxOrNull")) {
      const newest = sorted[sorted.length - 1];
      return [
        { cursor: newest?.ingestedAt, ingestedAt: newest?.ingestedAt, eventId: newest?.eventId },
      ];
    }
    const cursor = String(params.cursor);
    const cursorKey = `${cursor}\u0000${String(params.cursorId ?? "")}`;
    const lowerKey = params.lower ? `${params.lower}\u0000${params.lowerId}` : undefined;
    const stamps = (params.stamps as string[] | undefined) ?? [];
    const seen = (params.seen as string[] | undefined) ?? [];
    return sorted
      .filter((r) => ms(r.ingestedAt) >= ms(cursor) - 10_000)
      .filter((r) => lowerKey === undefined || key(r) > lowerKey)
      .filter((r) => stamps.length === 0 || key(r) > cursorKey || !stamps.includes(r.ingestedAt))
      .filter((r) => !seen.includes(r.eventId))
      .slice(0, LIVE_PAGE);
  };
}

describe("live queries (#148)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("initialLiveCursor", () => {
    it("starts at ClickHouse's clock — no table read, no replay — and the first window is the 10 s overlap, not 20", async () => {
      mockQueryAnalytics.mockResolvedValue([{ cursor: "2025-01-01 12:00:00.000" }]);
      const result = await initialLiveCursor(ctx);
      // No overlap of its own: the poll's window before the cursor is the overlap.
      expect(result).toEqual({
        ingestedAt: "2025-01-01 12:00:00.000",
        eventId: "",
        seen: [],
        connections: [],
      });
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("now64(3, 'UTC')");
      expect(call.query).not.toContain("INTERVAL 10 SECOND");
      // Not the newest ingested_at of the last hour (review round 4), which
      // replayed up to an hour-old events on every (re)connect: ingested_at
      // is on ClickHouse's clock since it stamps it at insert (round 5).
      expect(call.query).not.toContain("FROM events");
      expect(call.query).not.toContain("maxOrNull");
      expect(call.projectId).toBe("proj_1");

      mockQueryAnalytics.mockClear();
      mockQueryAnalytics.mockResolvedValue([]);
      await pollLive(ctx, result);
      const poll = mockQueryAnalytics.mock.calls[0][0];
      expect(poll.params.cursor).toBe("2025-01-01 12:00:00.000");
      expect(poll.query).toContain(
        "ingested_at >= {cursor:DateTime64(3, 'UTC')} - INTERVAL 10 SECOND",
      );
    });
  });

  describe("pollLive", () => {
    it("tails ingested_at with the overlap, bounds timestamp to the skew allowance before the cursor within the day, reads the page oldest first", async () => {
      mockQueryAnalytics.mockResolvedValue([]);
      await pollLive(ctx, cursor);
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain(
        "ingested_at >= {cursor:DateTime64(3, 'UTC')} - INTERVAL 10 SECOND",
      );
      // ingested_at is outside the sort key: without this bound every poll
      // sorted the project's whole last day (#148 review round 4).
      expect(call.query).toContain(
        `timestamp >= {cursor:DateTime64(3, 'UTC')} - INTERVAL ${10 + LIVE_SKEW_ALLOWANCE_SECONDS} SECOND`,
      );
      expect(LIVE_SKEW_ALLOWANCE_SECONDS).toBe(3_600);
      expect(call.query).toContain("timestamp >= now() - INTERVAL 1 DAY");
      // Oldest first, in the cursor's order: ClickHouse stamps one
      // ingested_at on a whole insert block, and a page of the newest 50
      // would return the same rows of such a block on every poll.
      expect(call.query).toContain("ORDER BY ingested_at ASC, event_id ASC");
      expect(call.query).not.toContain("ingested_at DESC");
      expect(call.query).not.toContain("timestamp > {since");
      expect(call.params.cursor).toBe("2025-01-01 12:00:00.000");
      expect(call.params.cursorId).toBe("");
      // Nothing read yet: no block left out, no lower bound, no id list
      // (review round 6: the query leaves out blocks, never ids).
      expect(call.query).not.toContain("NOT IN");
      expect(call.query).not.toContain("{lower:");
      expect(call.params.stamps).toBeUndefined();
      expect(call.params.seen).toBeUndefined();
      expect(call.params.lower).toBeUndefined();
    });

    it("shows a connection row only when it is its session's first in the last day — by (ingested_at, event_id), so two rows of one block cannot both pass", async () => {
      mockQueryAnalytics.mockResolvedValue([]);
      await pollLive(ctx, cursor);
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("event_type != 'connection'");
      expect(call.query).toContain("(session_id, ingested_at, event_id) IN (");
      expect(call.query).toContain(
        "SELECT session_id, min(ingested_at), argMin(event_id, (ingested_at, event_id))",
      );
      expect(call.query).toContain("GROUP BY session_id");
    });

    it("returns the rows in the page's order without the ingestedAt column, and advances the cursor to the newest position read", async () => {
      mockQueryAnalytics.mockResolvedValue([
        row({ eventId: "e1", ingestedAt: "2025-01-01 12:00:01.000" }),
        row({ eventId: "e2", ingestedAt: "2025-01-01 12:00:02.000" }),
      ]);
      const result = await pollLive(ctx, cursor);
      expect(result.events.map((e) => e.eventId)).toEqual(["e1", "e2"]);
      expect(result.events[0]).not.toHaveProperty("ingestedAt");
      expect(result.cursor.ingestedAt).toBe("2025-01-01 12:00:02.000");
      expect(result.cursor.eventId).toBe("e2");
      expect(result.cursor.resume).toBeUndefined();
      expect(result.cursor.seen).toEqual([
        { eventId: "e1", ingestedAt: "2025-01-01 12:00:01.000", readAt: expect.any(Number) },
        { eventId: "e2", ingestedAt: "2025-01-01 12:00:02.000", readAt: expect.any(Number) },
      ]);
    });

    it("keeps the cursor where it was when nothing was read; the query leaves out the blocks read inside the window, the cursor keeps the rows read within the resend horizon or inside the window", async () => {
      mockQueryAnalytics.mockResolvedValue([]);
      expect(LIVE_RESEND_HORIZON_SECONDS).toBe(200);
      const now = Date.now();
      const seen = [
        // Its block is inside the window: kept however long ago it was read.
        { eventId: "in-window", ingestedAt: "2025-01-01 11:59:55.000", readAt: now - 900_000 },
        { eventId: "in-window-too", ingestedAt: "2025-01-01 11:59:55.000", readAt: now - 5_000 },
        // Read 100 s ago: kept for the horizon, its block out of the window.
        { eventId: "in-horizon", ingestedAt: "2025-01-01 11:59:30.000", readAt: now - 100_000 },
        // Read 300 s ago, its block out of the window: forgotten.
        { eventId: "forgotten", ingestedAt: "2025-01-01 11:58:00.000", readAt: now - 300_000 },
      ];
      const result = await pollLive(ctx, { ...cursor, eventId: "in-window-too", seen });
      expect(result.events).toEqual([]);
      expect(result.cursor.ingestedAt).toBe(cursor.ingestedAt);
      expect(result.cursor.eventId).toBe("in-window-too");
      // Remembered for 200 s from the read — the SDK's five more attempts
      // of a 30 s fetch plus a backoff, review round 6 — and for as long
      // as the window covers the block, not only for the 10 s window
      // (review round 5). The query leaves out the BLOCKS read inside the
      // window — one stamp for the two rows — before the cursor, and takes
      // everything after it: an id list grew to a whole insert block of
      // up to 10 000 rows and went with every page (review round 6).
      expect(result.cursor.seen.map((r) => r.eventId)).toEqual([
        "in-window",
        "in-window-too",
        "in-horizon",
      ]);
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("ingested_at NOT IN {stamps:Array(DateTime64(3, 'UTC'))}");
      expect(call.query).toContain(
        "(ingested_at, event_id) > ({cursor:DateTime64(3, 'UTC')}, {cursorId:String})",
      );
      expect(call.query).not.toContain("{seen:");
      expect(call.params.stamps).toEqual(["2025-01-01 11:59:55.000"]);
      expect(call.params.cursorId).toBe("in-window-too");
    });

    it("leaves out the blocks the previous poll read (the overlap window) in the query, and remembers the rows inside the resend horizon", async () => {
      // `shown` is not in the page: the query excluded its block.
      mockQueryAnalytics.mockResolvedValue([
        row({ eventId: "late", ingestedAt: "2025-01-01 12:00:03.000" }),
        row({ eventId: "new", ingestedAt: "2025-01-01 12:00:15.000" }),
      ]);
      const result = await pollLive(ctx, {
        ingestedAt: "2025-01-01 12:00:08.000",
        eventId: "shown",
        seen: [{ eventId: "shown", ingestedAt: "2025-01-01 12:00:08.000", readAt: Date.now() }],
        connections: [],
      });
      expect(mockQueryAnalytics.mock.calls[0][0].params.stamps).toEqual([
        "2025-01-01 12:00:08.000",
      ]);
      // `late` became visible after `shown` was read but carries an older
      // ingested_at than the cursor: the overlap shows it, nothing is skipped.
      expect(result.events.map((e) => e.eventId)).toEqual(["late", "new"]);
      expect(result.cursor.ingestedAt).toBe("2025-01-01 12:00:15.000");
      expect(result.cursor.eventId).toBe("new");
      // All three stay remembered (the horizon reaches back to 11:59:15);
      // the next window starts at 12:00:05, so the next query leaves out
      // the blocks of `shown` (12:00:08) and `new`, not `late`'s (12:00:03).
      expect(result.cursor.seen.map((r) => r.eventId).sort()).toEqual(["late", "new", "shown"]);
      mockQueryAnalytics.mockClear();
      mockQueryAnalytics.mockResolvedValue([]);
      await pollLive(ctx, result.cursor);
      expect([...mockQueryAnalytics.mock.calls[0][0].params.stamps].sort()).toEqual([
        "2025-01-01 12:00:08.000",
        "2025-01-01 12:00:15.000",
      ]);
    });

    it("an SDK resend — the same event_id stored again 15 s later with a newer ingested_at, outside the query's NOT IN — is not shown again", async () => {
      // Poll 1: `r` at 12:00:00. Poll 2: `x` at 12:00:12 moves the cursor
      // past the window that covers `r`. Poll 3: the resend's row for `r`
      // at 12:00:15 (ingest wrote the batch, the SDK's fetch timed out, the
      // resend landed after the backoff) with `y`.
      mockQueryAnalytics.mockResolvedValueOnce([
        row({ eventId: "r", ingestedAt: "2025-01-01 12:00:00.000" }),
      ]);
      const first = await pollLive(ctx, cursor);
      expect(first.events.map((e) => e.eventId)).toEqual(["r"]);
      mockQueryAnalytics.mockResolvedValueOnce([
        row({ eventId: "x", ingestedAt: "2025-01-01 12:00:12.000" }),
      ]);
      const second = await pollLive(ctx, first.cursor);
      expect(second.events.map((e) => e.eventId)).toEqual(["x"]);
      expect(second.cursor.ingestedAt).toBe("2025-01-01 12:00:12.000");
      mockQueryAnalytics.mockResolvedValueOnce([
        row({ eventId: "r", ingestedAt: "2025-01-01 12:00:15.000" }),
        row({ eventId: "y", ingestedAt: "2025-01-01 12:00:16.000" }),
      ]);
      const third = await pollLive(ctx, second.cursor);
      // The window before 12:00:12 starts at 12:00:02: `r`'s block is out
      // of the parameter, and the resend's row — a new block after the
      // cursor — comes back from the query. Before the round-5 fix `r` was
      // forgotten with the window and emitted twice.
      expect(mockQueryAnalytics.mock.calls[2][0].params.stamps).toEqual([
        "2025-01-01 12:00:12.000",
      ]);
      expect(third.events.map((e) => e.eventId)).toEqual(["y"]);
      expect(third.cursor.ingestedAt).toBe("2025-01-01 12:00:16.000");
      // Remembered from the resend's ingested_at: the next query leaves the
      // resend's block out for as long as its window covers it.
      expect(third.cursor.seen.find((r) => r.eventId === "r")?.ingestedAt).toBe(
        "2025-01-01 12:00:15.000",
      );
      mockQueryAnalytics.mockResolvedValueOnce([]);
      await pollLive(ctx, third.cursor);
      expect([...mockQueryAnalytics.mock.calls[3][0].params.stamps].sort()).toEqual([
        "2025-01-01 12:00:12.000",
        "2025-01-01 12:00:15.000",
        "2025-01-01 12:00:16.000",
      ]);
    });

    it("a resend 63 s after the first read, the cursor having moved on twice meanwhile, is not shown again: the memory is keyed on when the row was read, for 200 s", async () => {
      // The SDK resends a batch ingest had already stored after each fetch
      // timeout (30 s) plus backoff: at about 31 s, then 63 s. Keyed on the
      // cursor's stamp with a 60 s horizon (review round 5), `r` had left
      // the memory once the cursor stood 63 s past its block, and the
      // resend at 64 s was shown a second time.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-01-01T12:00:00.500Z"));
      mockQueryAnalytics.mockResolvedValueOnce([
        row({ eventId: "r", ingestedAt: "2025-01-01 12:00:00.000" }),
      ]);
      const first = await pollLive(ctx, cursor);
      expect(first.events.map((e) => e.eventId)).toEqual(["r"]);
      const readAt = Date.now();
      vi.setSystemTime(new Date("2025-01-01T12:00:31.500Z"));
      mockQueryAnalytics.mockResolvedValueOnce([
        row({ eventId: "x", ingestedAt: "2025-01-01 12:00:31.000" }),
      ]);
      const second = await pollLive(ctx, first.cursor);
      expect(second.events.map((e) => e.eventId)).toEqual(["x"]);
      vi.setSystemTime(new Date("2025-01-01T12:01:03.500Z"));
      mockQueryAnalytics.mockResolvedValueOnce([
        row({ eventId: "z", ingestedAt: "2025-01-01 12:01:03.000" }),
      ]);
      const third = await pollLive(ctx, second.cursor);
      expect(third.events.map((e) => e.eventId)).toEqual(["z"]);
      expect(third.cursor.seen.map((r) => r.eventId).sort()).toEqual(["r", "x", "z"]);
      vi.setSystemTime(new Date("2025-01-01T12:01:04.500Z"));
      mockQueryAnalytics.mockResolvedValueOnce([
        row({ eventId: "r", ingestedAt: "2025-01-01 12:01:04.000" }),
      ]);
      const fourth = await pollLive(ctx, third.cursor);
      expect(fourth.events).toEqual([]);
      // Remembered from the first read, then read again now: from this
      // read, and from its new block.
      expect(first.cursor.seen).toEqual([
        { eventId: "r", ingestedAt: "2025-01-01 12:00:00.000", readAt },
      ]);
      expect(fourth.cursor.seen.find((r) => r.eventId === "r")).toEqual({
        eventId: "r",
        ingestedAt: "2025-01-01 12:01:04.000",
        readAt: Date.now(),
      });
      // 200 s after the last read, with the window past its block, it is
      // forgotten; the others went before it.
      vi.setSystemTime(new Date("2025-01-01T12:04:25.000Z"));
      mockQueryAnalytics.mockResolvedValueOnce([
        row({ eventId: "w", ingestedAt: "2025-01-01 12:04:24.000" }),
      ]);
      const fifth = await pollLive(ctx, fourth.cursor);
      expect(fifth.cursor.seen.map((r) => r.eventId)).toEqual(["w"]);
    });

    it("remembers at most LIVE_SEEN_CAP rows per feed: past the cap the rows read longest ago are forgotten first", async () => {
      expect(LIVE_SEEN_CAP).toBe(50_000);
      const now = Date.now();
      // Every row inside the window (so nothing else would drop it), read
      // at distinct times: the cap keeps the 50 000 most recently read.
      const seen = Array.from({ length: LIVE_SEEN_CAP + 10 }, (_, i) => ({
        eventId: `s${i}`,
        ingestedAt: "2025-01-01 11:59:59.000",
        readAt: now - i,
      }));
      mockQueryAnalytics.mockResolvedValue([]);
      const result = await pollLive(ctx, { ...cursor, seen });
      expect(result.cursor.seen).toHaveLength(LIVE_SEEN_CAP);
      const kept = new Set(result.cursor.seen.map((r) => r.eventId));
      expect(kept.has("s0")).toBe(true);
      expect(kept.has(`s${LIVE_SEEN_CAP - 1}`)).toBe(true);
      expect(kept.has(`s${LIVE_SEEN_CAP}`)).toBe(false);
      expect(kept.has(`s${LIVE_SEEN_CAP + 9}`)).toBe(false);
    });

    it("a stale page that repeats a seen row does not show it twice", async () => {
      mockQueryAnalytics.mockResolvedValue([
        row({ eventId: "shown", ingestedAt: "2025-01-01 12:00:08.000" }),
        row({ eventId: "new", ingestedAt: "2025-01-01 12:00:09.000" }),
      ]);
      const result = await pollLive(ctx, {
        ingestedAt: "2025-01-01 12:00:08.000",
        eventId: "shown",
        seen: [{ eventId: "shown", ingestedAt: "2025-01-01 12:00:08.000", readAt: Date.now() }],
        connections: [],
      });
      expect(result.events.map((e) => e.eventId)).toEqual(["new"]);
      expect(result.cursor.seen.map((r) => r.eventId).sort()).toEqual(["new", "shown"]);
    });

    it("the same event_id twice in one page — at-least-once duplicates before a merge — is shown once", async () => {
      mockQueryAnalytics.mockResolvedValue([
        row({ eventId: "dup", ingestedAt: "2025-01-01 12:00:01.000" }),
        row({ eventId: "dup", ingestedAt: "2025-01-01 12:00:01.000" }),
        row({ eventId: "other", ingestedAt: "2025-01-01 12:00:02.000" }),
      ]);
      const result = await pollLive(ctx, cursor);
      expect(result.events.map((e) => e.eventId)).toEqual(["dup", "other"]);
      expect(result.cursor.seen.map((r) => r.eventId).sort()).toEqual(["dup", "other"]);
    });

    it("walks a backlog within one poll: three pages, the third short — every row, each page after the last row of the one before, the cursor at the end", async () => {
      // Three insert blocks, one ingested_at each, 120 rows in all.
      const pages = [
        batch(50, "2025-01-01 12:00:30.000").map((r, i) => ({ ...r, eventId: `p1-${i}` })),
        batch(50, "2025-01-01 12:00:31.000").map((r, i) => ({ ...r, eventId: `p2-${i}` })),
        batch(20, "2025-01-01 12:00:32.000").map((r, i) => ({ ...r, eventId: `p3-${i}` })),
      ];
      for (const page of pages) mockQueryAnalytics.mockResolvedValueOnce(page);
      const result = await pollLive(ctx, cursor);
      // Before the fix one poll read one page: 50 rows per 1.5 s, and the
      // cursor fell behind for good above ~33 events/s.
      expect(result.events).toHaveLength(120);
      expect(mockQueryAnalytics).toHaveBeenCalledTimes(3);
      const calls = mockQueryAnalytics.mock.calls.map((c) => c[0]);
      // The pages walk by position: the cursor stays the poll's, the lower
      // bound is the last row of the page before, and no id list goes
      // along (review round 6).
      expect(calls[0].params.lower).toBeUndefined();
      expect(calls[1].params.cursor).toBe("2025-01-01 12:00:00.000");
      expect(calls[1].params.lower).toBe("2025-01-01 12:00:30.000");
      expect(calls[1].params.lowerId).toBe("p1-49");
      expect(calls[2].params.lower).toBe("2025-01-01 12:00:31.000");
      expect(calls[2].params.lowerId).toBe("p2-49");
      for (const call of calls) {
        expect(call.params.seen).toBeUndefined();
        expect(call.params.stamps).toBeUndefined();
      }
      expect(result.cursor.ingestedAt).toBe("2025-01-01 12:00:32.000");
      expect(result.cursor.eventId).toBe("p3-19");
      expect(result.cursor.resume).toBeUndefined();
      expect(result.cursor.seen).toHaveLength(120);
      expect(new Set(result.events.map((e) => e.eventId)).size).toBe(120);
      // No jump query: the short page ended the poll.
      expect(calls.some((c) => c.query.includes("maxOrNull"))).toBe(false);
    });

    /** Ten full pages, page k stamped 12:00:(10+k), then the jump query answered with `newest`. */
    function cappedPages(newest: { ingestedAt: string; eventId: string }) {
      let page = 0;
      mockQueryAnalytics.mockImplementation(async (call: { query: string }) => {
        if (call.query.includes("maxOrNull")) return [newest];
        const at = `2025-01-01 12:00:${String(10 + page).padStart(2, "0")}.000`;
        const rows = batch(LIVE_PAGE, at).map((r, i) => ({
          ...r,
          eventId: `p${page}-${String(i).padStart(2, "0")}`,
        }));
        page++;
        return rows;
      });
    }

    it("gives a backlog beyond the cap up: after LIVE_MAX_PAGES full pages, with the newest row more than one window ahead, the cursor jumps to the newest position; the next query leaves out only the window's blocks", async () => {
      cappedPages({ ingestedAt: "2025-01-01 12:00:35.000", eventId: "n" });
      const result = await pollLive(ctx, cursor);
      expect(mockQueryAnalytics).toHaveBeenCalledTimes(LIVE_MAX_PAGES + 1); // the pages, then the jump
      expect(result.events).toHaveLength(LIVE_PAGE * LIVE_MAX_PAGES);
      // The cursor is at the newest row, not at the last page read (12:00:19).
      expect(result.cursor.ingestedAt).toBe("2025-01-01 12:00:35.000");
      expect(result.cursor.eventId).toBe("n");
      expect(result.cursor.resume).toBeUndefined();
      // Every row read is inside the resend horizon (12:00:10 to 12:00:19,
      // the cursor at 12:00:35); the window before the cursor (12:00:25 on)
      // holds none of their blocks, so the next query has no stamps.
      expect(result.cursor.seen).toHaveLength(LIVE_PAGE * LIVE_MAX_PAGES);
      // The jump reads the newest position of the last hour by timestamp
      // (the sort key prunes), the clock only with no rows: the backlog it
      // gives up may end before the clock's window, and the blocks of its
      // last 10 s are what the next poll shows (review round 4) — and not
      // `max(ingested_at)` over the day, a full scan on every capped poll
      // (review round 3).
      const jump = mockQueryAnalytics.mock.calls[LIVE_MAX_PAGES][0];
      expect(jump.query).toContain("coalesce(maxOrNull(ingested_at), now64(3, 'UTC'))");
      expect(jump.query).toContain("argMaxOrNull(event_id, (ingested_at, event_id))");
      expect(jump.query).toContain("FROM events");
      expect(jump.query).toContain(
        `timestamp >= now() - INTERVAL ${LIVE_SKEW_ALLOWANCE_SECONDS} SECOND`,
      );
      expect(jump.query).not.toContain("INTERVAL 1 DAY");
      expect(jump.params.eventType).toBeUndefined();

      mockQueryAnalytics.mockClear();
      mockQueryAnalytics.mockResolvedValue([]);
      await pollLive(ctx, result.cursor);
      const next = mockQueryAnalytics.mock.calls[0][0];
      expect(next.params.cursor).toBe("2025-01-01 12:00:35.000");
      expect(next.params.cursorId).toBe("n");
      expect(next.params.stamps).toBeUndefined();
      expect(next.params.lower).toBeUndefined();
    });

    it("walks a backlog on instead of giving it up while the newest row is within one window of the last row read: the cursor stays at that row and the next poll continues after it", async () => {
      // The newest row at 12:00:25, the last page read at 12:00:19: six
      // seconds behind, inside the window — nothing to skip. Before review
      // round 6 every capped poll jumped, and the rows between were never
      // shown.
      cappedPages({ ingestedAt: "2025-01-01 12:00:25.000", eventId: "n" });
      const result = await pollLive(ctx, cursor);
      expect(mockQueryAnalytics).toHaveBeenCalledTimes(LIVE_MAX_PAGES + 1);
      expect(result.cursor.ingestedAt).toBe("2025-01-01 12:00:19.000");
      expect(result.cursor.eventId).toBe("p9-49");
      expect(result.cursor.resume).toBeUndefined();

      mockQueryAnalytics.mockClear();
      mockQueryAnalytics.mockResolvedValue([]);
      await pollLive(ctx, result.cursor);
      const next = mockQueryAnalytics.mock.calls[0][0];
      // After the cursor everything; before it (the window from 12:00:09)
      // only the blocks not read: the ten pages' stamps are left out.
      expect(next.params.cursor).toBe("2025-01-01 12:00:19.000");
      expect(next.params.cursorId).toBe("p9-49");
      expect([...next.params.stamps].sort()).toEqual(
        Array.from({ length: 10 }, (_, k) => `2025-01-01 12:00:${10 + k}.000`),
      );
    });

    it("the jump never moves the cursor backwards, and the pages and the jump keep the type filter", async () => {
      cappedPages({ ingestedAt: "2025-01-01 12:00:05.000", eventId: "n" }); // the filter's newest row, behind the last page read
      const result = await pollLive(ctx, cursor, "tool_call");
      expect(mockQueryAnalytics).toHaveBeenCalledTimes(LIVE_MAX_PAGES + 1);
      for (const [call] of mockQueryAnalytics.mock.calls) {
        expect(call.query).toContain("event_type = {eventType:String}");
        expect(call.params.eventType).toBe("tool_call");
      }
      expect(result.cursor.ingestedAt).toBe("2025-01-01 12:00:19.000");
      expect(result.cursor.eventId).toBe("p9-49");
    });

    it("a 1 200-row insert block with one ingested_at is walked out over three polls, nothing twice, with no id list and at most one stamp in any query", async () => {
      // ClickHouse stamps one ingested_at on a whole insert block (the
      // batch writer flushes up to 10 000 rows). Before review round 6 the
      // cursor was that stamp alone: it sat still inside the block, every
      // page had to leave out every id read so far (`event_id NOT IN …`),
      // and that list — the whole block in the end — went with every page
      // query of every poll while the window covered the block.
      mockQueryAnalytics.mockImplementation(table(batch(1_200, "2025-01-01 12:00:30.000")));
      const shown: string[] = [];
      let at = { ...cursor, ingestedAt: "2025-01-01 12:00:25.000" };
      const polls: number[] = [];
      for (let i = 0; i < 4; i++) {
        const result = await pollLive(ctx, at);
        polls.push(result.events.length);
        shown.push(...result.events.map((e) => e.eventId));
        at = result.cursor;
      }
      const pages = mockQueryAnalytics.mock.calls
        .map(([call]) => call)
        .filter((call) => !call.query.includes("maxOrNull"));
      expect(pages.length).toBeGreaterThanOrEqual(25);
      // No id list in any page query (before the fix: every id read so
      // far, 1 150 of them on the last page of the third poll), and at
      // most the block's one stamp.
      expect(pages.map((call) => call.params.seen).filter(Boolean)).toEqual([]);
      for (const call of pages) {
        expect((call.params.stamps ?? []).length).toBeLessThanOrEqual(1);
        expect((call.params.stamps ?? []).length).toBeLessThanOrEqual(LIVE_STAMPS_CAP);
      }
      expect(polls).toEqual([500, 500, 200, 0]);
      expect(new Set(shown).size).toBe(1_200);
      expect(at.ingestedAt).toBe("2025-01-01 12:00:30.000");
      expect(at.eventId).toBe("b1199");
      expect(at.resume).toBeUndefined();
    });

    it("carries the sessions shown with a connection across polls for the window: an earlier row of the session in a block visible late is not a second connection", async () => {
      // Poll 1: the session's connection c2 (block 12:00:05). Poll 2: a
      // block stamped 12:00:01 becomes visible with c1 of the same session
      // — now the session's earliest, so it passes the query's filter — and
      // must not be shown as a second connection. Before review round 6
      // the sessions shown were known per poll only.
      mockQueryAnalytics.mockResolvedValueOnce([
        row({
          eventId: "c2",
          eventType: "connection",
          sessionId: "s",
          ingestedAt: "2025-01-01 12:00:05.000",
        }),
      ]);
      const first = await pollLive(ctx, cursor);
      expect(first.events.map((e) => e.eventId)).toEqual(["c2"]);
      mockQueryAnalytics.mockResolvedValueOnce([
        row({
          eventId: "c1",
          eventType: "connection",
          sessionId: "s",
          ingestedAt: "2025-01-01 12:00:01.000",
        }),
        row({
          eventId: "t",
          eventType: "tool_call",
          sessionId: "s",
          ingestedAt: "2025-01-01 12:00:06.000",
        }),
      ]);
      const second = await pollLive(ctx, first.cursor);
      expect(second.events.map((e) => e.eventId)).toEqual(["t"]);
      // Carried in the cursor while the window covers the block shown;
      // gone once the cursor has moved more than the window past it.
      expect(first.cursor.connections).toEqual([
        { sessionId: "s", ingestedAt: "2025-01-01 12:00:05.000" },
      ]);
      expect(second.cursor.connections).toEqual([
        { sessionId: "s", ingestedAt: "2025-01-01 12:00:05.000" },
      ]);
      mockQueryAnalytics.mockResolvedValueOnce([
        row({
          eventId: "u",
          eventType: "tool_call",
          sessionId: "s",
          ingestedAt: "2025-01-01 12:00:16.000",
        }),
      ]);
      const third = await pollLive(ctx, second.cursor);
      expect(third.cursor.connections).toEqual([]);
    });

    it("shows one connection per session per poll: the earliest ingested", async () => {
      mockQueryAnalytics.mockResolvedValue([
        row({
          eventId: "o1",
          eventType: "connection",
          sessionId: "other",
          ingestedAt: "2025-01-01 12:00:00.500",
        }),
        row({
          eventId: "c1",
          eventType: "connection",
          sessionId: "s",
          ingestedAt: "2025-01-01 12:00:01.000",
        }),
        row({
          eventId: "t1",
          eventType: "tool_call",
          sessionId: "s",
          ingestedAt: "2025-01-01 12:00:01.500",
        }),
        row({
          eventId: "c2",
          eventType: "connection",
          sessionId: "s",
          ingestedAt: "2025-01-01 12:00:02.000",
        }),
      ]);
      const result = await pollLive(ctx, cursor);
      expect(result.events.map((e) => e.eventId)).toEqual(["o1", "c1", "t1"]);
    });

    it("ranks a day of connection rows only when a connection can be in the page, over the sessions of the window", async () => {
      mockQueryAnalytics.mockResolvedValue([]);
      await pollLive(ctx, cursor, "tool_call");
      const typed = mockQueryAnalytics.mock.calls[0][0];
      // A type that is never a connection: no subquery at all (before the
      // fix it ran on every poll of every type).
      expect(typed.query).not.toContain("argMin(");
      expect(typed.query).not.toContain("event_type != 'connection'");

      for (const type of [undefined, "connection"]) {
        mockQueryAnalytics.mockClear();
        await pollLive(ctx, cursor, type);
        const call = mockQueryAnalytics.mock.calls[0][0];
        expect(call.query).toContain(
          "SELECT session_id, min(ingested_at), argMin(event_id, (ingested_at, event_id))",
        );
        // The candidates are the sessions with a connection row in the
        // polled window — the only ones the page can hold — not every
        // session of the day: the same window as the page, with its
        // timestamp bound (two cursor placeholders each).
        expect(call.query).toContain("AND session_id IN (");
        expect(call.query.split("{cursor:DateTime64(3, 'UTC')}")).toHaveLength(5);
        expect(
          call.query.split(
            `timestamp >= {cursor:DateTime64(3, 'UTC')} - INTERVAL ${10 + LIVE_SKEW_ALLOWANCE_SECONDS} SECOND`,
          ),
        ).toHaveLength(3);
      }
    });

    it("applies the event type filter", async () => {
      mockQueryAnalytics.mockResolvedValue([]);
      await pollLive(ctx, cursor, "tool_call");
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("event_type = {eventType:String}");
      expect(call.params.eventType).toBe("tool_call");
    });

    it("does not apply the filter when eventType is undefined", async () => {
      mockQueryAnalytics.mockResolvedValue([]);
      await pollLive(ctx, cursor);
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).not.toContain("event_type = {eventType:String}");
      expect(call.params.eventType).toBeUndefined();
    });
  });
});
