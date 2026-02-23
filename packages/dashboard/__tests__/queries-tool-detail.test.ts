import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQueryAnalytics = vi.fn();

vi.mock("@/lib/clickhouse/analytics-client", () => ({
  queryAnalytics: (...args: unknown[]) => mockQueryAnalytics(...args),
}));

import {
  queryToolCallVolume,
  queryToolDetailKPIs,
  queryToolErrorCategories,
  queryToolLatencyPercentiles,
  queryToolPlatformBreakdown,
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
      expect(result).toHaveLength(2);
      expect(result[0].bucket).toBe("2025-01-01");
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
});
