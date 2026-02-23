import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQueryAnalytics = vi.fn();

vi.mock("@/lib/clickhouse/analytics-client", () => ({
  queryAnalytics: (...args: unknown[]) => mockQueryAnalytics(...args),
}));

import {
  queryErrorCategoryBreakdown,
  queryErrorList,
  queryErrorRateTimeSeries,
} from "@/lib/queries/errors";

const baseCtx = {
  workspaceId: "ws_1",
  projectId: "proj_1",
  from: "2025-01-01T00:00:00.000Z",
  to: "2025-01-08T00:00:00.000Z",
};

describe("error queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("queryErrorRateTimeSeries", () => {
    it("uses granularity function", async () => {
      mockQueryAnalytics.mockResolvedValue([]);
      await queryErrorRateTimeSeries(baseCtx, "hour");
      expect(mockQueryAnalytics.mock.calls[0][0].query).toContain("toStartOfHour");
    });
  });

  describe("queryErrorCategoryBreakdown", () => {
    it("calculates percentages", async () => {
      mockQueryAnalytics.mockResolvedValue([
        { category: "timeout", count: 60 },
        { category: "validation", count: 40 },
      ]);

      const result = await queryErrorCategoryBreakdown(baseCtx);
      expect(result[0].percentage).toBe(0.6);
      expect(result[1].percentage).toBe(0.4);
    });
  });

  describe("queryErrorList", () => {
    it("returns paginated errors with total", async () => {
      mockQueryAnalytics
        .mockResolvedValueOnce([
          {
            eventId: "e1",
            timestamp: "2025-01-01",
            toolName: "search",
            errorCategory: "timeout",
            errorMessage: "timed out",
            platform: "cursor",
          },
        ])
        .mockResolvedValueOnce([{ total: 100 }]);

      const result = await queryErrorList(baseCtx, 1, 25);
      expect(result.errors).toHaveLength(1);
      expect(result.total).toBe(100);
    });

    it("applies error category filter", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

      await queryErrorList(baseCtx, 1, 25, "timeout");
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("error_category = {errorCategory:String}");
      expect(call.params.errorCategory).toBe("timeout");
    });
  });
});
