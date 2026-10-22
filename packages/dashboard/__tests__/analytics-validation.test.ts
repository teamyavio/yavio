import {
  TOOL_FILTER_MAX_LENGTH,
  analyticsFiltersSchema,
  granularityToClickHouse,
  invocationFiltersSchema,
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
      platform: "cursor,claude-code",
    });
    expect(result.platform).toEqual(["cursor", "claude-code"]);
  });

  it("drops unrecognised platform values instead of rejecting", () => {
    // Bookmarked URLs may carry values from older releases (e.g.
    // "claude-desktop") — they must degrade to "no filter", not a 400.
    const result = analyticsFiltersSchema.parse({
      platform: "cursor,claude-desktop",
    });
    expect(result.platform).toEqual(["cursor"]);
  });

  it("degrades to an empty filter when no platform value is recognised", () => {
    const result = analyticsFiltersSchema.parse({
      platform: "invalid-platform",
    });
    expect(result.platform).toEqual([]);
  });

  it("rejects invalid granularity", () => {
    const result = analyticsFiltersSchema.safeParse({
      granularity: "second",
    });
    expect(result.success).toBe(false);
  });
});

describe("invocationFiltersSchema (#44)", () => {
  it("treats absence as 'all invocations'", () => {
    const result = invocationFiltersSchema.parse({});
    expect(result).toEqual({ hasIntent: false });
  });

  it("reads the has-intent flag and the status and tool filters", () => {
    expect(invocationFiltersSchema.parse({ hasIntent: "1" }).hasIntent).toBe(true);
    expect(invocationFiltersSchema.parse({ hasIntent: "true" }).hasIntent).toBe(true);
    expect(invocationFiltersSchema.parse({ hasIntent: "0" }).hasIntent).toBe(false);
    expect(invocationFiltersSchema.parse({ status: "error", tool: " search " })).toEqual({
      hasIntent: false,
      status: "error",
      tool: "search",
    });
  });

  it("rejects an unknown status", () => {
    expect(invocationFiltersSchema.safeParse({ status: "pending" }).success).toBe(false);
  });

  // #146 review round 1, finding 2: a pasted or hand-written tool value
  // must never turn the whole page into an error banner.
  it("cuts an overlong tool name instead of rejecting it", () => {
    const result = invocationFiltersSchema.safeParse({ tool: "x".repeat(201) });
    expect(result.success).toBe(true);
    expect(result.data?.tool).toBe("x".repeat(TOOL_FILTER_MAX_LENGTH));
  });

  it("treats a blank tool name as no filter", () => {
    expect(invocationFiltersSchema.parse({ tool: "   " }).tool).toBeUndefined();
    expect(invocationFiltersSchema.parse({ tool: "" }).tool).toBeUndefined();
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
