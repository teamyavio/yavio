import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQueryAnalytics = vi.fn();

vi.mock("@/lib/clickhouse/analytics-client", () => ({
  queryAnalytics: (...args: unknown[]) => mockQueryAnalytics(...args),
}));

import { queryIntentFeed, queryIntentKPIs } from "@/lib/queries/intents";

const baseCtx = {
  workspaceId: "ws_1",
  projectId: "proj_1",
  from: "2025-01-01 00:00:00.000",
  to: "2025-01-08 00:00:00.000",
};

describe("intents queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("queryIntentFeed", () => {
    it("returns intents with total and dedupes on event_id", async () => {
      mockQueryAnalytics
        .mockResolvedValueOnce([
          {
            eventId: "evt_1",
            timestamp: "2025-01-07 12:00:00.000",
            intent: "Searching the catalog for the user",
            source: "context_parameter",
            toolName: "search",
            platform: "chatgpt",
            status: "success",
            sessionId: "ses_1",
          },
        ])
        // ClickHouse serialises count()/UInt64 as a JSON string
        .mockResolvedValueOnce([{ total: "42" }]);

      const result = await queryIntentFeed(baseCtx, 1, 25);
      expect(result.intents).toHaveLength(1);
      expect(result.total).toBe(42);

      const feedCall = mockQueryAnalytics.mock.calls[0][0];
      expect(feedCall.query).toContain("LIMIT 1 BY event_id");
      expect(feedCall.query).toContain("intent_signals != '{}'");
      const countCall = mockQueryAnalytics.mock.calls[1][0];
      expect(countCall.query).toContain("count(DISTINCT event_id)");
    });

    it("applies pagination offset and platform filter", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

      await queryIntentFeed({ ...baseCtx, platform: ["claude"] }, 3, 10);
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.params.offset).toBe(20);
      expect(call.params.limit).toBe(10);
      expect(call.query).toContain("platform IN");
      expect(call.params.platforms).toEqual(["claude"]);
    });

    it("orders deterministically so pages cannot shuffle on timestamp ties", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: "0" }]);

      await queryIntentFeed(baseCtx, 1, 25);
      expect(mockQueryAnalytics.mock.calls[0][0].query).toContain(
        "ORDER BY timestamp DESC, event_id DESC",
      );
    });
  });

  describe("queryIntentKPIs", () => {
    it("computes coverage from captured over total calls", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([
        { captured: 30, totalCalls: 120, toolsWithIntents: 5 },
      ]);

      expect(await queryIntentKPIs(baseCtx)).toEqual({
        captured: 30,
        coverage: 0.25,
        toolsWithIntents: 5,
      });
    });

    it("returns zero coverage when there are no tool calls", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([
        { captured: 0, totalCalls: 0, toolsWithIntents: 0 },
      ]);

      expect(await queryIntentKPIs(baseCtx)).toEqual({
        captured: 0,
        coverage: 0,
        toolsWithIntents: 0,
      });
    });

    it("applies the platform filter to the KPI aggregates", async () => {
      // The KPI query builds its own filter clause; without this assertion the
      // filter can be dropped and the headline numbers would silently disagree
      // with the (correctly filtered) feed below them.
      mockQueryAnalytics.mockResolvedValueOnce([
        { captured: 3, totalCalls: 10, toolsWithIntents: 2 },
      ]);

      await queryIntentKPIs({ ...baseCtx, platform: ["gemini"] });
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("platform IN");
      expect(call.params.platforms).toEqual(["gemini"]);
    });

    it("coerces ClickHouse string aggregates to numbers", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([
        { captured: "8", totalCalls: "16", toolsWithIntents: "3" },
      ]);

      expect(await queryIntentKPIs(baseCtx)).toEqual({
        captured: 8,
        coverage: 0.5,
        toolsWithIntents: 3,
      });
    });
  });
});
