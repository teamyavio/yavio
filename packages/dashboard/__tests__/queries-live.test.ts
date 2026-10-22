import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQueryAnalytics = vi.fn();

vi.mock("@/lib/clickhouse/analytics-client", () => ({
  queryAnalytics: (...args: unknown[]) => mockQueryAnalytics(...args),
}));

import {
  LIVE_MAX_PAGES,
  LIVE_PAGE,
  LIVE_SKEW_ALLOWANCE_SECONDS,
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

const cursor = { ingestedAt: "2025-01-01 12:00:00.000", seen: [] };

/** `n` rows of one request batch: one `ingested_at` for all of them (ingest stamps the batch). */
function batch(n: number, ingestedAt: string) {
  return Array.from({ length: n }, (_, i) =>
    row({ eventId: `b${String(i).padStart(3, "0")}`, ingestedAt }),
  );
}

describe("live queries (#148)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("initialLiveCursor", () => {
    it("starts one overlap window before ClickHouse's clock", async () => {
      mockQueryAnalytics.mockResolvedValue([{ cursor: "2025-01-01 11:59:50.000" }]);
      const result = await initialLiveCursor(ctx);
      expect(result).toEqual({ ingestedAt: "2025-01-01 11:59:50.000", seen: [] });
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("now64(3, 'UTC') - INTERVAL 10 SECOND");
      expect(call.projectId).toBe("proj_1");
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
      // Oldest first: ingest stamps one ingested_at on a whole request
      // batch, and a page of the newest 50 would return the same rows of
      // such a batch on every poll.
      expect(call.query).toContain("ORDER BY ingested_at ASC, timestamp ASC, event_id ASC");
      expect(call.query).not.toContain("ingested_at DESC");
      expect(call.query).not.toContain("timestamp > {since");
      expect(call.params.cursor).toBe("2025-01-01 12:00:00.000");
      // No seen rows: no exclusion and no parameter.
      expect(call.query).not.toContain("NOT IN");
      expect(call.params.seen).toBeUndefined();
    });

    it("shows a connection row only when it is its session's first in the last day", async () => {
      mockQueryAnalytics.mockResolvedValue([]);
      await pollLive(ctx, cursor);
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("event_type != 'connection'");
      expect(call.query).toContain("SELECT session_id, min(ingested_at)");
      expect(call.query).toContain("GROUP BY session_id");
    });

    it("returns the rows in the page's order without the ingestedAt column, and advances the cursor to the newest ingested_at", async () => {
      mockQueryAnalytics.mockResolvedValue([
        row({ eventId: "e1", ingestedAt: "2025-01-01 12:00:01.000" }),
        row({ eventId: "e2", ingestedAt: "2025-01-01 12:00:02.000" }),
      ]);
      const result = await pollLive(ctx, cursor);
      expect(result.events.map((e) => e.eventId)).toEqual(["e1", "e2"]);
      expect(result.events[0]).not.toHaveProperty("ingestedAt");
      expect(result.cursor.ingestedAt).toBe("2025-01-01 12:00:02.000");
      expect(result.cursor.seen).toEqual([
        { eventId: "e1", ingestedAt: "2025-01-01 12:00:01.000" },
        { eventId: "e2", ingestedAt: "2025-01-01 12:00:02.000" },
      ]);
    });

    it("keeps the cursor where it was when nothing was read, and the seen rows still inside the window", async () => {
      mockQueryAnalytics.mockResolvedValue([]);
      const seen = [{ eventId: "old", ingestedAt: "2025-01-01 11:59:55.000" }];
      const result = await pollLive(ctx, { ...cursor, seen });
      expect(result).toEqual({ events: [], cursor: { ingestedAt: cursor.ingestedAt, seen } });
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("AND event_id NOT IN {seen:Array(String)}");
      expect(call.params.seen).toEqual(["old"]);
    });

    it("leaves out the rows the previous poll read (the overlap window) in the query, and keeps only the ones still inside the window", async () => {
      // `shown` is not in the page: the query excluded it.
      mockQueryAnalytics.mockResolvedValue([
        row({ eventId: "late", ingestedAt: "2025-01-01 12:00:03.000" }),
        row({ eventId: "new", ingestedAt: "2025-01-01 12:00:15.000" }),
      ]);
      const result = await pollLive(ctx, {
        ingestedAt: "2025-01-01 12:00:08.000",
        seen: [{ eventId: "shown", ingestedAt: "2025-01-01 12:00:08.000" }],
      });
      expect(mockQueryAnalytics.mock.calls[0][0].params.seen).toEqual(["shown"]);
      // `late` was ingested after `shown` was read but carries an older
      // ingested_at than the cursor: the overlap shows it, nothing is skipped.
      expect(result.events.map((e) => e.eventId)).toEqual(["late", "new"]);
      expect(result.cursor.ingestedAt).toBe("2025-01-01 12:00:15.000");
      // The next window starts at 12:00:05: `late` (12:00:03) cannot come
      // back; `shown` (12:00:08) can, and stays excluded.
      expect(result.cursor.seen.map((r) => r.eventId).sort()).toEqual(["new", "shown"]);
    });

    it("a stale page that repeats a seen row does not show it twice", async () => {
      mockQueryAnalytics.mockResolvedValue([
        row({ eventId: "shown", ingestedAt: "2025-01-01 12:00:08.000" }),
        row({ eventId: "new", ingestedAt: "2025-01-01 12:00:09.000" }),
      ]);
      const result = await pollLive(ctx, {
        ingestedAt: "2025-01-01 12:00:08.000",
        seen: [{ eventId: "shown", ingestedAt: "2025-01-01 12:00:08.000" }],
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

    it("walks a backlog within one poll: three pages, the third short — every row, each page leaving out the ones before, the cursor at the end", async () => {
      // Three request batches, one ingested_at each, 120 rows in all.
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
      expect(calls[0].params.seen).toBeUndefined();
      expect(calls[1].params.cursor).toBe("2025-01-01 12:00:30.000");
      expect(calls[1].params.seen).toEqual(pages[0].map((r) => r.eventId));
      expect(calls[2].params.cursor).toBe("2025-01-01 12:00:31.000");
      expect(calls[2].params.seen).toHaveLength(100);
      expect(result.cursor.ingestedAt).toBe("2025-01-01 12:00:32.000");
      expect(result.cursor.seen).toHaveLength(120);
      expect(new Set(result.events.map((e) => e.eventId)).size).toBe(120);
      // No jump query: the short page ended the poll.
      expect(calls.some((c) => c.query.includes("now64"))).toBe(false);
    });

    it("gives a backlog beyond the cap up: after LIVE_MAX_PAGES full pages the cursor jumps to ClickHouse's clock and seen keeps only the window", async () => {
      // Every page full and fresh: page k ingested at 12:00:(10+k).
      let page = 0;
      mockQueryAnalytics.mockImplementation(async (call: { query: string }) => {
        if (call.query.includes("now64")) {
          return [{ cursor: "2025-01-01 12:00:25.000" }];
        }
        const at = `2025-01-01 12:00:${String(10 + page).padStart(2, "0")}.000`;
        const rows = batch(LIVE_PAGE, at).map((r, i) => ({ ...r, eventId: `p${page}-${i}` }));
        page++;
        return rows;
      });
      const result = await pollLive(ctx, cursor);
      expect(mockQueryAnalytics).toHaveBeenCalledTimes(LIVE_MAX_PAGES + 1); // the pages, then the jump
      expect(result.events).toHaveLength(LIVE_PAGE * LIVE_MAX_PAGES);
      // The cursor is at the clock, not at the last page read (12:00:19).
      expect(result.cursor.ingestedAt).toBe("2025-01-01 12:00:25.000");
      // `seen` is bounded to the new window: pages ingested at 12:00:15 and later.
      expect(result.cursor.seen).toHaveLength(LIVE_PAGE * 5);
      expect(result.cursor.seen.every((r) => r.ingestedAt >= "2025-01-01 12:00:15.000")).toBe(true);
      // The jump reads the clock, not `max(ingested_at)` over the day — a
      // full scan on every capped poll, during the spike that causes the
      // backlog (#148 review round 3).
      const jump = mockQueryAnalytics.mock.calls[LIVE_MAX_PAGES][0];
      expect(jump.query).toContain("SELECT toString(now64(3, 'UTC')) AS cursor");
      expect(jump.query).not.toContain("FROM events");
      expect(jump.query).not.toContain("max(ingested_at)");
    });

    it("the jump never moves the cursor backwards, and the pages keep the type filter", async () => {
      let page = 0;
      mockQueryAnalytics.mockImplementation(async (call: { query: string }) => {
        if (call.query.includes("now64")) {
          return [{ cursor: "2025-01-01 12:00:05.000" }]; // a clock behind the last page read
        }
        const at = `2025-01-01 12:00:${String(10 + page).padStart(2, "0")}.000`;
        const rows = batch(LIVE_PAGE, at).map((r, i) => ({ ...r, eventId: `p${page}-${i}` }));
        page++;
        return rows;
      });
      const result = await pollLive(ctx, cursor, "tool_call");
      expect(mockQueryAnalytics).toHaveBeenCalledTimes(LIVE_MAX_PAGES + 1);
      for (const [call] of mockQueryAnalytics.mock.calls.slice(0, LIVE_MAX_PAGES)) {
        expect(call.query).toContain("event_type = {eventType:String}");
        expect(call.params.eventType).toBe("tool_call");
      }
      expect(result.cursor.ingestedAt).toBe("2025-01-01 12:00:19.000");
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
      expect(typed.query).not.toContain("min(ingested_at)");
      expect(typed.query).not.toContain("event_type != 'connection'");

      for (const type of [undefined, "connection"]) {
        mockQueryAnalytics.mockClear();
        await pollLive(ctx, cursor, type);
        const call = mockQueryAnalytics.mock.calls[0][0];
        expect(call.query).toContain("SELECT session_id, min(ingested_at)");
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
