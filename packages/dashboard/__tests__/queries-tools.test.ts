import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQueryAnalytics = vi.fn();

vi.mock("@/lib/clickhouse/analytics-client", () => ({
  queryAnalytics: (...args: unknown[]) => mockQueryAnalytics(...args),
}));

import {
  queryToolErrorRateTimeSeries,
  queryToolLatencyHistogram,
  queryToolList,
} from "@/lib/queries/tools";

const baseCtx = {
  workspaceId: "ws_1",
  projectId: "proj_1",
  from: "2025-01-01T00:00:00.000Z",
  to: "2025-01-08T00:00:00.000Z",
};

describe("tool queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("queryToolList", () => {
    it("returns tools with total count", async () => {
      mockQueryAnalytics
        .mockResolvedValueOnce([
          {
            toolName: "search",
            callCount: 100,
            successRate: 0.95,
            avgLatencyMs: 50,
            errorRate: 0.05,
          },
        ])
        .mockResolvedValueOnce([{ total: 5 }]);

      const result = await queryToolList(baseCtx, 1, 25);
      expect(result.tools).toHaveLength(1);
      expect(result.total).toBe(5);
    });

    it("applies pagination offset", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

      await queryToolList(baseCtx, 3, 10);
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.params.offset).toBe(20);
      expect(call.params.limit).toBe(10);
    });

    it("applies platform filter", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

      await queryToolList({ ...baseCtx, platform: ["cursor"] }, 1, 25);
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("platform IN");
    });
  });

  describe("queryToolLatencyHistogram", () => {
    it("queries latency buckets for specific tool", async () => {
      mockQueryAnalytics.mockResolvedValue([
        { rangeLabel: "0-50ms", count: 100 },
        { rangeLabel: "50-100ms", count: 50 },
      ]);

      const result = await queryToolLatencyHistogram(baseCtx, "search");
      expect(result).toHaveLength(2);

      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.params.tool).toBe("search");
    });
  });

  describe("queryToolErrorRateTimeSeries", () => {
    it("returns error rate time series for a tool", async () => {
      mockQueryAnalytics.mockResolvedValue([
        { bucket: "2025-01-01", value: 0.05 },
        { bucket: "2025-01-02", value: 0.1 },
      ]);

      const result = await queryToolErrorRateTimeSeries(baseCtx, "search", "day");
      expect(result).toHaveLength(2);
      expect(result[0].value).toBe(0.05);
    });

    it("uses correct granularity function", async () => {
      mockQueryAnalytics.mockResolvedValue([]);
      await queryToolErrorRateTimeSeries(baseCtx, "search", "hour");
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("toStartOfHour");
    });

    it("passes tool name as parameter", async () => {
      mockQueryAnalytics.mockResolvedValue([]);
      await queryToolErrorRateTimeSeries(baseCtx, "my-tool", "day");
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.params.tool).toBe("my-tool");
    });

    it("applies platform filter when provided", async () => {
      mockQueryAnalytics.mockResolvedValue([]);
      await queryToolErrorRateTimeSeries({ ...baseCtx, platform: ["cursor"] }, "search", "day");
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("platform IN");
      expect(call.params.platforms).toEqual(["cursor"]);
    });
  });
});
