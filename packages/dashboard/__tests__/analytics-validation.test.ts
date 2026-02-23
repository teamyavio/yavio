import {
  analyticsFiltersSchema,
  granularityToClickHouse,
  paginationSchema,
  parseAnalyticsParams,
} from "@/lib/analytics/validation";
import { describe, expect, it } from "vitest";

describe("analyticsFiltersSchema", () => {
  it("provides defaults for from/to/granularity", () => {
    const result = analyticsFiltersSchema.parse({});
    expect(result.from).toBeDefined();
    expect(result.to).toBeDefined();
    expect(result.granularity).toBe("day");
    expect(result.platform).toBeUndefined();
  });

  it("parses valid ISO dates", () => {
    const result = analyticsFiltersSchema.parse({
      from: "2025-01-01T00:00:00.000Z",
      to: "2025-01-07T00:00:00.000Z",
      granularity: "hour",
    });
    expect(result.from).toBe("2025-01-01 00:00:00.000");
    expect(result.granularity).toBe("hour");
  });

  it("parses comma-separated platforms", () => {
    const result = analyticsFiltersSchema.parse({
      platform: "cursor,claude-desktop",
    });
    expect(result.platform).toEqual(["cursor", "claude-desktop"]);
  });

  it("rejects invalid platform values", () => {
    const result = analyticsFiltersSchema.safeParse({
      platform: "invalid-platform",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid granularity", () => {
    const result = analyticsFiltersSchema.safeParse({
      granularity: "second",
    });
    expect(result.success).toBe(false);
  });
});

describe("paginationSchema", () => {
  it("provides defaults", () => {
    const result = paginationSchema.parse({});
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(25);
    expect(result.order).toBe("desc");
  });

  it("coerces string numbers", () => {
    const result = paginationSchema.parse({ page: "3", pageSize: "50" });
    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(50);
  });

  it("rejects pageSize > 100", () => {
    const result = paginationSchema.safeParse({ pageSize: "200" });
    expect(result.success).toBe(false);
  });

  it("rejects page < 1", () => {
    const result = paginationSchema.safeParse({ page: "0" });
    expect(result.success).toBe(false);
  });
});

describe("parseAnalyticsParams", () => {
  it("parses from URLSearchParams", () => {
    const params = new URLSearchParams({
      from: "2025-01-01T00:00:00.000Z",
      to: "2025-01-07T00:00:00.000Z",
      granularity: "week",
      page: "2",
      pageSize: "50",
    });

    const { filters, pagination } = parseAnalyticsParams(params);
    expect(filters.success).toBe(true);
    expect(pagination.success).toBe(true);
    if (filters.success) {
      expect(filters.data.granularity).toBe("week");
    }
    if (pagination.success) {
      expect(pagination.data.page).toBe(2);
    }
  });
});

describe("granularityToClickHouse", () => {
  it("maps granularity to ClickHouse functions", () => {
    expect(granularityToClickHouse("hour")).toBe("toStartOfHour");
    expect(granularityToClickHouse("day")).toBe("toStartOfDay");
    expect(granularityToClickHouse("week")).toBe("toStartOfWeek");
    expect(granularityToClickHouse("month")).toBe("toStartOfMonth");
  });
});
