import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQueryAnalytics = vi.fn();

vi.mock("@/lib/clickhouse/analytics-client", () => ({
  queryAnalytics: (...args: unknown[]) => mockQueryAnalytics(...args),
}));

import { initialLiveCursor, pollLive } from "@/lib/queries/live";

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
    it("tails ingested_at with the overlap, keeps the timestamp partition bound, reads the page oldest first", async () => {
      mockQueryAnalytics.mockResolvedValue([]);
      await pollLive(ctx, cursor);
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain(
        "ingested_at >= {cursor:DateTime64(3, 'UTC')} - INTERVAL 10 SECOND",
      );
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

    it("walks a backlog larger than a page: a 100-row batch with one ingested_at is read in two pages, the second leaving out the first", async () => {
      const at = "2025-01-01 12:00:30.000";
      mockQueryAnalytics.mockResolvedValueOnce(batch(100, at).slice(0, 50));
      const first = await pollLive(ctx, cursor);
      expect(first.events).toHaveLength(50);
      expect(first.cursor.ingestedAt).toBe(at);
      expect(first.cursor.seen).toHaveLength(50);

      mockQueryAnalytics.mockResolvedValueOnce(batch(100, at).slice(50));
      const second = await pollLive(ctx, first.cursor);
      const call = mockQueryAnalytics.mock.calls[1][0];
      expect(call.params.seen).toEqual(first.cursor.seen.map((r) => r.eventId));
      expect(second.events).toHaveLength(50);
      expect(second.cursor.seen).toHaveLength(100);
      const ids = new Set([...first.events, ...second.events].map((e) => e.eventId));
      expect(ids.size).toBe(100);
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
        // session of the day.
        expect(call.query).toContain("AND session_id IN (");
        expect(call.query.split("{cursor:DateTime64(3, 'UTC')}")).toHaveLength(3);
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
