import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQueryAnalytics = vi.fn();

vi.mock("@/lib/clickhouse/analytics-client", () => ({
  queryAnalytics: (...args: unknown[]) => mockQueryAnalytics(...args),
}));

import {
  queryActiveUsers,
  queryNewVsReturning,
  queryRetentionCohorts,
  queryUserDetail,
  queryUserList,
} from "@/lib/queries/users";

const baseCtx = {
  workspaceId: "ws_1",
  projectId: "proj_1",
  from: "2025-01-01T00:00:00.000Z",
  to: "2025-01-08T00:00:00.000Z",
};

describe("user queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("queryUserList", () => {
    it("returns paginated users with total", async () => {
      mockQueryAnalytics
        .mockResolvedValueOnce([
          {
            userId: "u1",
            firstSeen: "2025-01-01",
            lastSeen: "2025-01-07",
            totalEvents: 100,
            totalSessions: 5,
            totalToolCalls: 80,
            totalConversions: 2,
            totalRevenue: 50,
            lastPlatform: "cursor",
          },
        ])
        .mockResolvedValueOnce([{ total: 42 }]);

      const result = await queryUserList(baseCtx, 1, 25);
      expect(result.users).toHaveLength(1);
      expect(result.total).toBe(42);
    });

    it("uses FINAL keyword on materialized view", async () => {
      mockQueryAnalytics.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
      await queryUserList(baseCtx, 1, 25);
      expect(mockQueryAnalytics.mock.calls[0][0].query).toContain("users_mv FINAL");
    });
  });

  describe("queryActiveUsers", () => {
    it("returns DAU/WAU/MAU data", async () => {
      mockQueryAnalytics.mockResolvedValue([{ bucket: "2025-01-01", dau: 10, wau: 50, mau: 200 }]);

      const result = await queryActiveUsers(baseCtx, "day");
      expect(result[0].dau).toBe(10);
      expect(result[0].wau).toBe(50);
    });
  });

  describe("queryRetentionCohorts", () => {
    it("returns cohort data with ordered retention periods", async () => {
      mockQueryAnalytics.mockResolvedValue([
        { cohortPeriod: "2025-01-01", cohortSize: 100, retentionByPeriod: [100, 80, 60] },
      ]);

      const result = await queryRetentionCohorts(baseCtx, "week");
      expect(result).toHaveLength(1);
      expect(result[0].cohortSize).toBe(100);
      expect(result[0].retentionByPeriod).toEqual([100, 80, 60]);
    });

    it("uses toStartOfDay for day period", async () => {
      mockQueryAnalytics.mockResolvedValue([]);
      await queryRetentionCohorts(baseCtx, "day");
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("toStartOfDay");
      expect(call.query).toContain("'DAY'");
    });

    it("uses toStartOfMonth for month period", async () => {
      mockQueryAnalytics.mockResolvedValue([]);
      await queryRetentionCohorts(baseCtx, "month");
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("toStartOfMonth");
      expect(call.query).toContain("'MONTH'");
    });

    it("uses ORDER BY in groupArray for correct period ordering", async () => {
      mockQueryAnalytics.mockResolvedValue([]);
      await queryRetentionCohorts(baseCtx, "week");
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("groupArray(period_count ORDER BY period_offset)");
    });
  });

  describe("queryNewVsReturning", () => {
    it("returns new vs returning user counts per bucket", async () => {
      mockQueryAnalytics.mockResolvedValue([
        { bucket: "2025-01-01", newUsers: 10, returningUsers: 30 },
        { bucket: "2025-01-02", newUsers: 5, returningUsers: 35 },
      ]);

      const result = await queryNewVsReturning(baseCtx, "day");
      expect(result).toHaveLength(2);
      expect(result[0].newUsers).toBe(10);
      expect(result[0].returningUsers).toBe(30);
    });

    it("uses correct granularity function", async () => {
      mockQueryAnalytics.mockResolvedValue([]);
      await queryNewVsReturning(baseCtx, "hour");
      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.query).toContain("toStartOfHour");
    });
  });

  describe("queryUserDetail", () => {
    it("queries events for specific user", async () => {
      mockQueryAnalytics.mockResolvedValue([
        { eventId: "e1", eventType: "tool_call", timestamp: "2025-01-01" },
      ]);

      const result = await queryUserDetail(baseCtx, "user_123");
      expect(result).toHaveLength(1);

      const call = mockQueryAnalytics.mock.calls[0][0];
      expect(call.params.userId).toBe("user_123");
    });
  });
});
