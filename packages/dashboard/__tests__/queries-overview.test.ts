import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQueryAnalytics = vi.fn();

vi.mock("@/lib/clickhouse/analytics-client", () => ({
  queryAnalytics: (...args: unknown[]) => mockQueryAnalytics(...args),
}));

import {
  queryInvocationsTimeSeries,
  queryOverviewKPIs,
  queryPlatformBreakdown,
  queryTopTools,
} from "@/lib/queries/overview";

const baseCtx = {
  workspaceId: "ws_1",
  projectId: "proj_1",
  from: "2025-01-01T00:00:00.000Z",
  to: "2025-01-08T00:00:00.000Z",
};

describe("overview queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("queryOverviewKPIs", () => {
    it("returns 6 KPI results with correct labels", async () => {
      mockQueryAnalytics.mockResolvedValue([
        {
          invocations: 1000,
          prev_invocations: 800,
          sessions: 50,
          prev_sessions: 40,
          error_rate: 0.05,
          prev_error_rate: 0.03,
          avg_latency: 120,
          prev_avg_latency: 100,
          conversions: 10,
          prev_conversions: 8,
          revenue: 500,
          prev_revenue: 400,
        },
      ]);

      const kpis = await queryOverviewKPIs(baseCtx);
      expect(kpis).toHaveLength(6);
      expect(kpis[0].label).toBe("Invocations");
      expect(kpis[0].value).toBe(1000);
      expect(kpis[0].previousValue).toBe(800);
      expect(kpis[2].format).toBe("percent");
    });

    it("injects project_id and time params", async () => {
      mockQueryAnalytics.mockResolvedValue([{}]);

      await queryOverviewKPIs(baseCtx);

      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.params.projectId).toBe("proj_1");
      expect(call.params.from).toBe(baseCtx.from);
      expect(call.params.to).toBe(baseCtx.to);
      expect(call.workspaceId).toBe("ws_1");
      expect(call.projectId).toBe("proj_1");
    });
  });

  describe("queryInvocationsTimeSeries", () => {
    it("uses correct granularity function", async () => {
      mockQueryAnalytics.mockResolvedValue([]);

      await queryInvocationsTimeSeries(baseCtx, "hour");
      expect(mockQueryAnalytics.mock.calls[0][0].query).toContain("toStartOfHour");

      await queryInvocationsTimeSeries(baseCtx, "week");
      expect(mockQueryAnalytics.mock.calls[1][0].query).toContain("toStartOfWeek");
    });
  });

  describe("queryPlatformBreakdown", () => {
    it("calculates percentages", async () => {
      mockQueryAnalytics.mockResolvedValue([
        { platform: "cursor", count: 80 },
        { platform: "claude-desktop", count: 20 },
      ]);

      const result = await queryPlatformBreakdown(baseCtx);
      expect(result[0].percentage).toBe(0.8);
      expect(result[1].percentage).toBe(0.2);
    });
  });

  describe("queryTopTools", () => {
    it("passes platform filter when provided", async () => {
      mockQueryAnalytics.mockResolvedValue([]);

      await queryTopTools({ ...baseCtx, platform: ["cursor"] });
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("platform IN");
      expect(call.params.platforms).toEqual(["cursor"]);
    });
  });
});
