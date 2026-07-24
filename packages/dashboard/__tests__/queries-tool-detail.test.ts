import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQueryAnalytics = vi.fn();

vi.mock("@/lib/clickhouse/analytics-client", () => ({
  queryAnalytics: (...args: unknown[]) => mockQueryAnalytics(...args),
}));

import {
  queryIntentStatus,
  queryToolCallVolume,
  queryToolDetailKPIs,
  queryToolErrorCategories,
  queryToolLatencyPercentiles,
  queryToolPlatformBreakdown,
  queryToolRecentIntents,
  queryToolRecentInvocations,
  queryToolRegistryEntry,
} from "@/lib/queries/tool-detail";

const baseCtx = {
  workspaceId: "ws_1",
  projectId: "proj_1",
  from: "2025-01-01 00:00:00.000",
  to: "2025-01-08 00:00:00.000",
};

describe("tool detail queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("queryToolDetailKPIs", () => {
    it("returns KPI results with previous period", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([
        {
          totalCalls: 500,
          prevTotalCalls: 400,
          successRate: 0.95,
          prevSuccessRate: 0.9,
          avgLatencyMs: 120,
          prevAvgLatencyMs: 150,
          errorRate: 0.05,
          prevErrorRate: 0.1,
        },
      ]);

      const result = await queryToolDetailKPIs(baseCtx, "search");
      expect(result).toHaveLength(4);
      expect(result[0].label).toBe("Total Calls");
      expect(result[0].value).toBe(500);
      expect(result[0].previousValue).toBe(400);
    });

    it("passes tool name to query params", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([{}]);

      await queryToolDetailKPIs(baseCtx, "my-tool");
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.params.tool).toBe("my-tool");
    });

    it("applies platform filter", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([{}]);

      await queryToolDetailKPIs({ ...baseCtx, platform: ["cursor"] }, "search");
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("platform IN");
      expect(call.params.platforms).toEqual(["cursor"]);
    });
  });

  describe("queryToolCallVolume", () => {
    it("returns time series points", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([
        { bucket: "2025-01-01", value: 100 },
        { bucket: "2025-01-02", value: 150 },
      ]);

      const result = await queryToolCallVolume(baseCtx, "search", "day");
      // 7-day range zero-fills to 7 buckets; real rows keep their values.
      expect(result).toHaveLength(7);
      expect(result[0].bucket).toBe("2025-01-01");
      expect(result[0].value).toBe(100);
      expect(result[2].value).toBe(0);
    });

    it("passes tool and uses granularity function", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([]);

      await queryToolCallVolume(baseCtx, "search", "hour");
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.params.tool).toBe("search");
      expect(call.query).toContain("toStartOfHour");
    });

    it("applies platform filter", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([]);

      await queryToolCallVolume({ ...baseCtx, platform: ["cursor"] }, "search", "day");
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("platform IN");
    });
  });

  describe("queryToolLatencyPercentiles", () => {
    it("returns percentile points", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([
        { bucket: "2025-01-01", p50: 50, p95: 200, p99: 500 },
      ]);

      const result = await queryToolLatencyPercentiles(baseCtx, "search", "day");
      expect(result).toHaveLength(1);
      expect(result[0].p50).toBe(50);
      expect(result[0].p95).toBe(200);
      expect(result[0].p99).toBe(500);
    });

    it("filters for non-null latency", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([]);

      await queryToolLatencyPercentiles(baseCtx, "search", "day");
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("latency_ms IS NOT NULL");
    });
  });

  describe("queryToolErrorCategories", () => {
    it("returns categories with percentages", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([
        { category: "timeout", count: 30 },
        { category: "validation", count: 20 },
      ]);

      const result = await queryToolErrorCategories(baseCtx, "search");
      expect(result).toHaveLength(2);
      expect(result[0].category).toBe("timeout");
      expect(result[0].percentage).toBe(0.6);
      expect(result[1].percentage).toBe(0.4);
    });

    it("scopes to specific tool and error status", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([]);

      await queryToolErrorCategories(baseCtx, "search");
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.params.tool).toBe("search");
      expect(call.query).toContain("status = 'error'");
    });
  });

  describe("queryToolPlatformBreakdown", () => {
    it("returns breakdown with percentages", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([
        { platform: "cursor", count: 60 },
        { platform: "claude-desktop", count: 40 },
      ]);

      const result = await queryToolPlatformBreakdown(baseCtx, "search");
      expect(result).toHaveLength(2);
      expect(result[0].platform).toBe("cursor");
      expect(result[0].percentage).toBe(0.6);
    });

    it("scopes to specific tool", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([]);

      await queryToolPlatformBreakdown(baseCtx, "search");
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.params.tool).toBe("search");
    });
  });

  describe("queryToolRecentInvocations", () => {
    it("returns invocations with total", async () => {
      mockQueryAnalytics
        .mockResolvedValueOnce([
          {
            eventId: "ev_1",
            timestamp: "2025-01-07 12:00:00.000",
            traceId: "tr_1",
            sessionId: "ses_1",
            userId: "user_1",
            status: "success",
            latencyMs: 50,
            platform: "cursor",
            errorCategory: null,
            errorMessage: null,
            isRetry: 0,
          },
        ])
        .mockResolvedValueOnce([{ total: 100 }]);

      const result = await queryToolRecentInvocations(baseCtx, "search", 1, 25);
      expect(result.invocations).toHaveLength(1);
      expect(result.total).toBe(100);
    });

    it("applies pagination offset", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

      await queryToolRecentInvocations(baseCtx, "search", 3, 10);
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.params.offset).toBe(20);
      expect(call.params.limit).toBe(10);
    });

    it("applies platform filter", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

      await queryToolRecentInvocations({ ...baseCtx, platform: ["cursor"] }, "search", 1, 25);
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("platform IN");
    });
  });

  describe("queryToolRegistryEntry", () => {
    it("returns entry when found", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([
        {
          toolName: "search",
          description: "Search the web",
          inputSchema: '{"type":"object"}',
          registeredAt: "2025-01-01 00:00:00.000",
          updatedAt: "2025-01-05 00:00:00.000",
        },
      ]);

      const result = await queryToolRegistryEntry(baseCtx, "search");
      expect(result).not.toBeNull();
      expect(result?.toolName).toBe("search");
      expect(result?.description).toBe("Search the web");
    });

    it("returns null when not found", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([]);

      const result = await queryToolRegistryEntry(baseCtx, "nonexistent");
      expect(result).toBeNull();
    });

    it("queries tool_registry table with FINAL", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([]);

      await queryToolRegistryEntry(baseCtx, "search");
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("tool_registry FINAL");
    });
  });

  describe("queryToolRecentIntents", () => {
    it("returns intent rows and filters empty intent_signals", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([
        {
          eventId: "evt_1",
          timestamp: "2025-01-02 10:00:00.000",
          intent: "Searching the catalog for the user",
          source: "context_parameter",
          sessionId: "ses_1",
          status: "success",
        },
      ]);

      const result = await queryToolRecentIntents(baseCtx, "search");
      expect(result).toHaveLength(1);
      expect(result[0].intent).toBe("Searching the catalog for the user");
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("intent_signals != '{}'");
      expect(call.query).toContain("JSONExtractString(intent_signals, 'intent')");
      expect(call.params.tool).toBe("search");
    });

    it("applies date range and platform filters like sibling queries", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([]);

      await queryToolRecentIntents({ ...baseCtx, platform: ["claude"] }, "search");
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("timestamp >= {from:DateTime64(3)}");
      expect(call.query).toContain("platform IN");
      expect(call.params.platforms).toEqual(["claude"]);
    });
  });

  describe("queryIntentStatus", () => {
    it("reports enabled from the 7-day window in a single query", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([
        { cnt: 5, hasFlag: 1, enabled: 1, sdkVersion: "0.2.0" },
      ]);

      expect(await queryIntentStatus(baseCtx)).toEqual({
        status: "enabled",
        sdkVersion: "0.2.0",
      });
      expect(mockQueryAnalytics).toHaveBeenCalledTimes(1);
      expect(mockQueryAnalytics.mock.calls[0][0].query).toContain("INTERVAL 7 DAY");
    });

    it("reports enabled when a mixed fleet has any enabled instance", async () => {
      // max() aggregation: one 0.1.x connection + one 0.2.0 enabled connection
      mockQueryAnalytics.mockResolvedValueOnce([
        { cnt: 2, hasFlag: 1, enabled: 1, sdkVersion: "0.1.7" },
      ]);

      expect((await queryIntentStatus(baseCtx)).status).toBe("enabled");
    });

    it("reports disabled when the flag is present but false", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([
        { cnt: 3, hasFlag: 1, enabled: 0, sdkVersion: "0.2.0" },
      ]);

      expect((await queryIntentStatus(baseCtx)).status).toBe("disabled");
    });

    it("reports unsupported for pre-0.2.0 connections without the flag", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([
        { cnt: 1, hasFlag: 0, enabled: 0, sdkVersion: "0.1.7" },
      ]);

      expect(await queryIntentStatus(baseCtx)).toEqual({
        status: "unsupported",
        sdkVersion: "0.1.7",
      });
    });

    it("falls back to the latest connection ever when the window is empty", async () => {
      mockQueryAnalytics
        .mockResolvedValueOnce([{ cnt: 0, hasFlag: 0, enabled: 0, sdkVersion: null }])
        .mockResolvedValueOnce([{ cnt: 1, hasFlag: 1, enabled: 1, sdkVersion: "0.2.0" }]);

      expect(await queryIntentStatus(baseCtx)).toEqual({
        status: "enabled",
        sdkVersion: "0.2.0",
      });
      expect(mockQueryAnalytics).toHaveBeenCalledTimes(2);
    });

    it("reports unknown when no connection events exist at all", async () => {
      mockQueryAnalytics
        .mockResolvedValueOnce([{ cnt: 0, hasFlag: 0, enabled: 0, sdkVersion: null }])
        .mockResolvedValueOnce([]);

      expect(await queryIntentStatus(baseCtx)).toEqual({ status: "unknown", sdkVersion: null });
    });
  });
});
