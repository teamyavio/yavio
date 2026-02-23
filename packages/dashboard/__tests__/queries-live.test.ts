import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQueryAnalytics = vi.fn();

vi.mock("@/lib/clickhouse/analytics-client", () => ({
  queryAnalytics: (...args: unknown[]) => mockQueryAnalytics(...args),
}));

import { queryRecentEvents } from "@/lib/queries/live";

describe("live queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("queryRecentEvents", () => {
    it("queries events since timestamp", async () => {
      mockQueryAnalytics.mockResolvedValue([
        {
          eventId: "e1",
          eventType: "tool_call",
          eventName: "search",
          timestamp: "2025-01-01T12:00:00.000Z",
          sessionId: "s1",
          traceId: "t1",
          userId: null,
          platform: "cursor",
          status: "success",
          latencyMs: 100,
          errorCategory: null,
          errorMessage: null,
        },
      ]);

      const result = await queryRecentEvents(
        { workspaceId: "ws_1", projectId: "proj_1" },
        "2025-01-01T11:00:00.000Z",
      );
      expect(result).toHaveLength(1);
      expect(result[0].eventId).toBe("e1");

      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.params.since).toBe("2025-01-01 11:00:00.000");
    });

    it("applies event type filter", async () => {
      mockQueryAnalytics.mockResolvedValue([]);

      await queryRecentEvents(
        { workspaceId: "ws_1", projectId: "proj_1" },
        "2025-01-01T00:00:00.000Z",
        "tool_call",
      );

      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("event_type = {eventType:String}");
      expect(call.params.eventType).toBe("tool_call");
    });

    it("does not apply filter when eventType is undefined", async () => {
      mockQueryAnalytics.mockResolvedValue([]);

      await queryRecentEvents(
        { workspaceId: "ws_1", projectId: "proj_1" },
        "2025-01-01T00:00:00.000Z",
      );

      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).not.toContain("event_type = {eventType:String}");
    });
  });
});
