import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQueryAnalytics = vi.fn();

vi.mock("@/lib/clickhouse/analytics-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clickhouse/analytics-client")>()),
  queryAnalytics: (...args: unknown[]) => mockQueryAnalytics(...args),
}));

import { AnalyticsQueryError } from "@/lib/clickhouse/analytics-client";
import {
  perRequestCallsHint,
  queryInvocationsTimeSeries,
  queryLocationBreakdown,
  queryLocationBreakdownOrNull,
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

    it("Sessions leaves per_request sessions out and says how many calls had no session key (#144)", async () => {
      mockQueryAnalytics.mockResolvedValue([{ sessions: 4, per_request_calls: "1234" }]);
      const kpis = await queryOverviewKPIs(baseCtx);
      const sessions = kpis.find((k) => k.label === "Sessions");
      expect(sessions?.value).toBe(4);
      expect(sessions?.hint).toBe("1,234 calls from clients without a session key");
      // Only the Sessions KPI carries it.
      expect(kpis.filter((k) => k.hint !== undefined)).toHaveLength(1);
      const query = mockQueryAnalytics.mock.calls[0][0].query as string;
      expect(query).toContain(
        "uniqExactIf(session_id, ifNull(session_source, '') != 'per_request' AND timestamp >= {from",
      );
      expect(query).toContain(
        "uniqExactIf(session_id, ifNull(session_source, '') != 'per_request' AND timestamp >= {prevFrom",
      );
    });

    it("says nothing when every call had a session key, and is singular for one call", async () => {
      expect(perRequestCallsHint(0)).toBeUndefined();
      expect(perRequestCallsHint(Number.NaN)).toBeUndefined();
      expect(perRequestCallsHint(1)).toBe("1 call from a client without a session key");
      mockQueryAnalytics.mockResolvedValue([{ sessions: 4, per_request_calls: 0 }]);
      const kpis = await queryOverviewKPIs(baseCtx);
      expect(kpis.find((k) => k.label === "Sessions")?.hint).toBeUndefined();
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
        { is_country: "1", country: "", region_name: "", tool_calls: "7", users: "1" },
        { is_country: "1", country: "DE", region_name: "", tool_calls: "3", users: "2" },
        { is_country: 0, country: "DE", region_name: "", tool_calls: "1", users: "1" },
        { is_country: 0, country: "DE", region_name: "Hesse", tool_calls: "2", users: "2" },
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
        ],
        unknown: { toolCalls: 7, users: 1 },
      });
      const call = mockQueryAnalytics.mock.calls[0][0];
      // One pass: the keyed CTE is inlined per reference, a UNION would scan twice.
      expect(call.query).toContain("GROUPING SETS");
      expect(call.query).not.toContain("UNION");
      // Tool calls of the selected platforms are filtered inside keyed, before its join.
      expect(call.query).toMatch(
        /keyed AS \([\s\S]*AND e\.event_type = 'tool_call' AND e\.platform IN \(\{platforms:Array\(String\)\}\)[\s\S]*\)\s*SELECT grouping/,
      );
      expect(call.params.platforms).toEqual(["chatgpt"]);
      expect(call.workspaceId).toBe("ws_1");
      expect(call.projectId).toBe("proj_1");
    });

    it("has no Unknown bucket when every call had a country", async () => {
      mockQueryAnalytics.mockResolvedValue([
        { is_country: 1, country: "US", region_name: "", tool_calls: "2", users: "1" },
      ]);
      const result = await queryLocationBreakdown(baseCtx);
      expect(result.unknown).toBeNull();
      expect(result).toMatchObject({ totalToolCalls: 2, locatedToolCalls: 2 });
    });
  });

  describe("queryLocationBreakdownOrNull", () => {
    it("is null when ClickHouse fails the query, so only the card is lost", async () => {
      mockQueryAnalytics.mockRejectedValue(
        new AnalyticsQueryError("DASHBOARD_ANALYTICS_QUERY_FAILED", "Query failed", 500),
      );
      await expect(queryLocationBreakdownOrNull(baseCtx)).resolves.toBeNull();
    });

    it("still throws anything else", async () => {
      mockQueryAnalytics.mockRejectedValue(new TypeError("bug"));
      await expect(queryLocationBreakdownOrNull(baseCtx)).rejects.toThrow("bug");
    });
  });

  describe("topLocations", () => {
    it("keeps the largest countries and regions, marks every cut, keeps the totals", () => {
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
      const full = {
        totalToolCalls: 100,
        locatedToolCalls: 90,
        countries: Array.from({ length: 12 }, (_, i) => country(`C${i}`, 12 - i)),
        unknown: { toolCalls: 10, users: 0 },
      };

      const top = topLocations(full);
      expect(top.countries.map((c) => c.countryCode)).toEqual(
        full.countries.slice(0, 10).map((c) => c.countryCode),
      );
      expect(top.countries.every((c) => c.regions.length === 5 && c.moreRegions === 2)).toBe(true);
      expect(top).toMatchObject({
        totalToolCalls: 100,
        locatedToolCalls: 90,
        moreCountries: 2,
        unknown: { toolCalls: 10, users: 0 },
      });
      expect(full.countries[0].regions).toHaveLength(7); // the input is not cut
    });

    it("keeps a country's Unknown region however many known regions are cut", () => {
      const regions = [
        ...Array.from({ length: 7 }, (_, i) => ({ region: `R${i}`, toolCalls: 1, users: 1 })),
        { region: null, toolCalls: 60, users: 9 },
      ];
      const top = topLocations({
        totalToolCalls: 67,
        locatedToolCalls: 67,
        countries: [{ countryCode: "DE", toolCalls: 67, users: 10, regions }],
        unknown: null,
      });
      expect(top.countries[0].regions.map((r) => r.region)).toEqual([
        "R0",
        "R1",
        "R2",
        "R3",
        "R4",
        null,
      ]);
      expect(top.countries[0].moreRegions).toBe(2);
    });

    it("marks nothing when nothing was cut", () => {
      const top = topLocations({
        totalToolCalls: 1,
        locatedToolCalls: 1,
        countries: [
          {
            countryCode: "DE",
            toolCalls: 1,
            users: 1,
            regions: [{ region: "Hesse", toolCalls: 1, users: 1 }],
          },
        ],
        unknown: null,
      });
      expect(top).toMatchObject({ moreCountries: 0, unknown: null });
      expect(top.countries[0].moreRegions).toBe(0);
    });
  });
});
