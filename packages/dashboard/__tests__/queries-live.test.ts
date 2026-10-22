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
    it("tails ingested_at with the overlap, keeps the timestamp partition bound, orders by ingested_at", async () => {
      mockQueryAnalytics.mockResolvedValue([]);
      await pollLive(ctx, cursor);
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain(
        "ingested_at >= {cursor:DateTime64(3, 'UTC')} - INTERVAL 10 SECOND",
      );
      expect(call.query).toContain("timestamp >= now() - INTERVAL 1 DAY");
      expect(call.query).toContain("ORDER BY ingested_at DESC");
      expect(call.query).not.toContain("timestamp > {since");
      expect(call.params.cursor).toBe("2025-01-01 12:00:00.000");
    });

    it("shows a connection row only when it is its session's first in the last day", async () => {
      mockQueryAnalytics.mockResolvedValue([]);
      await pollLive(ctx, cursor);
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("event_type != 'connection'");
      expect(call.query).toContain("SELECT session_id, min(ingested_at)");
      expect(call.query).toContain("GROUP BY session_id");
    });

    it("returns the rows oldest first without the ingestedAt column, and advances the cursor to the newest ingested_at", async () => {
      mockQueryAnalytics.mockResolvedValue([
        row({ eventId: "e2", ingestedAt: "2025-01-01 12:00:02.000" }),
        row({ eventId: "e1", ingestedAt: "2025-01-01 12:00:01.000" }),
      ]);
      const result = await pollLive(ctx, cursor);
      expect(result.events.map((e) => e.eventId)).toEqual(["e1", "e2"]);
      expect(result.events[0]).not.toHaveProperty("ingestedAt");
      expect(result.cursor.ingestedAt).toBe("2025-01-01 12:00:02.000");
      expect(result.cursor.seen.sort()).toEqual(["e1", "e2"]);
    });

    it("keeps the cursor where it was when nothing was read", async () => {
      mockQueryAnalytics.mockResolvedValue([]);
      const result = await pollLive(ctx, { ...cursor, seen: ["old"] });
      expect(result).toEqual({ events: [], cursor: { ingestedAt: cursor.ingestedAt, seen: [] } });
    });

    it("drops the rows the previous poll showed (the overlap window), and keeps only the ids still inside the window", async () => {
      mockQueryAnalytics.mockResolvedValue([
        row({ eventId: "new", ingestedAt: "2025-01-01 12:00:15.000" }),
        row({ eventId: "shown", ingestedAt: "2025-01-01 12:00:08.000" }),
        row({ eventId: "late", ingestedAt: "2025-01-01 12:00:03.000" }),
      ]);
      const result = await pollLive(ctx, {
        ingestedAt: "2025-01-01 12:00:08.000",
        seen: ["shown"],
      });
      // `late` was ingested after `shown` was read but carries an older
      // ingested_at than the cursor: the overlap shows it, nothing is skipped.
      expect(result.events.map((e) => e.eventId)).toEqual(["late", "new"]);
      expect(result.cursor.ingestedAt).toBe("2025-01-01 12:00:15.000");
      // The next window starts at 12:00:05: `late` (12:00:03) cannot come back.
      expect(result.cursor.seen.sort()).toEqual(["new", "shown"]);
    });

    it("shows one connection per session per poll: the earliest ingested", async () => {
      mockQueryAnalytics.mockResolvedValue([
        row({
          eventId: "c2",
          eventType: "connection",
          sessionId: "s",
          ingestedAt: "2025-01-01 12:00:02.000",
        }),
        row({
          eventId: "t1",
          eventType: "tool_call",
          sessionId: "s",
          ingestedAt: "2025-01-01 12:00:01.500",
        }),
        row({
          eventId: "c1",
          eventType: "connection",
          sessionId: "s",
          ingestedAt: "2025-01-01 12:00:01.000",
        }),
        row({
          eventId: "o1",
          eventType: "connection",
          sessionId: "other",
          ingestedAt: "2025-01-01 12:00:00.500",
        }),
      ]);
      const result = await pollLive(ctx, cursor);
      expect(result.events.map((e) => e.eventId)).toEqual(["o1", "c1", "t1"]);
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
