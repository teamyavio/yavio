import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQueryAnalytics = vi.fn();

vi.mock("@/lib/clickhouse/analytics-client", () => ({
  queryAnalytics: (...args: unknown[]) => mockQueryAnalytics(...args),
}));

import {
  queryInvocationsTimeSeries,
  queryLocationBreakdown,
  queryOverviewKPIs,
  queryPlatformBreakdown,
  queryTopTools,
  topLocations,
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

  // The SQL runs on a real ClickHouse in queries-locations.test.ts; this pins
  // the assembly of the rows it returns (#129).
  describe("queryLocationBreakdown", () => {
    it("coerces UInt64 strings and nests regions under their country", async () => {
      mockQueryAnalytics.mockResolvedValue([
        { level: "country", country: "", region_name: "", tool_calls: "7", users: "1" },
        { level: "country", country: "DE", region_name: "", tool_calls: "3", users: "2" },
        { level: "region", country: "DE", region_name: "", tool_calls: "1", users: "1" },
        { level: "region", country: "DE", region_name: "Hesse", tool_calls: "2", users: "2" },
      ]);

      const result = await queryLocationBreakdown({ ...baseCtx, platform: ["chatgpt"] });
      expect(result).toEqual({
        totalToolCalls: 10,
        locatedToolCalls: 3,
        countries: [
          {
            countryCode: "DE",
            toolCalls: 3,
            users: 2,
            regions: [
              { region: "Hesse", toolCalls: 2, users: 2 },
              { region: null, toolCalls: 1, users: 1 },
            ],
          },
          { countryCode: null, toolCalls: 7, users: 1, regions: [] },
        ],
      });
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.params.platforms).toEqual(["chatgpt"]);
      expect(call.workspaceId).toBe("ws_1");
      expect(call.projectId).toBe("proj_1");
    });
  });

  describe("topLocations", () => {
    it("keeps the largest countries and regions, and the full totals", () => {
      const country = (code: string, calls: number) => ({
        countryCode: code,
        toolCalls: calls,
        users: 1,
        regions: Array.from({ length: 7 }, (_, i) => ({
          region: `R${i}`,
          toolCalls: 1,
          users: 1,
        })),
      });
      const unknown = { countryCode: null, toolCalls: 10, users: 0, regions: [] };
      const full = {
        totalToolCalls: 100,
        locatedToolCalls: 90,
        countries: [...Array.from({ length: 12 }, (_, i) => country(`C${i}`, 12 - i)), unknown],
      };

      const top = topLocations(full);
      // The Unknown bucket sorts last and is kept even though it is the 13th.
      expect(top.countries.map((c) => c.countryCode)).toEqual([
        ...full.countries.slice(0, 10).map((c) => c.countryCode),
        null,
      ]);
      expect(top.countries.slice(0, 10).every((c) => c.regions.length === 5)).toBe(true);
      expect(top).toMatchObject({ totalToolCalls: 100, locatedToolCalls: 90, moreCountries: 2 });
      expect(full.countries[0].regions).toHaveLength(7); // the input is not cut
    });
  });
});
