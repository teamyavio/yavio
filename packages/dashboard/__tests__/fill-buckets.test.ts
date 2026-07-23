import { fillTimeBuckets } from "@/lib/analytics/fill-buckets";
import { describe, expect, it } from "vitest";

const empty = (bucket: string) => ({ bucket, value: 0 });

describe("fillTimeBuckets", () => {
  it("fills missing day buckets with zeros and keeps real rows", () => {
    const rows = [
      { bucket: "2025-01-01 00:00:00", value: 10 },
      { bucket: "2025-01-03 00:00:00", value: 20 },
    ];
    const result = fillTimeBuckets(
      rows,
      "2025-01-01T00:00:00.000Z",
      "2025-01-08T00:00:00.000Z",
      "day",
      empty,
    );
    expect(result).toHaveLength(7);
    expect(result[0].value).toBe(10);
    expect(result[1].value).toBe(0);
    expect(result[2].value).toBe(20);
    expect(result.slice(3).every((r) => r.value === 0)).toBe(true);
  });

  it("matches date-only buckets against generated datetime keys", () => {
    const rows = [{ bucket: "2025-01-02", value: 5 }];
    const result = fillTimeBuckets(
      rows,
      "2025-01-01T00:00:00.000Z",
      "2025-01-04T00:00:00.000Z",
      "day",
      empty,
    );
    expect(result).toHaveLength(3);
    expect(result[1].value).toBe(5);
    expect(result[1].bucket).toBe("2025-01-02");
  });

  it("parses ClickHouse-format bounds (no timezone marker) as UTC", () => {
    const iso = fillTimeBuckets([], "2025-01-01T00:00:00.000Z", "2025-01-02T00:00:00.000Z", "hour", empty);
    const ch = fillTimeBuckets([], "2025-01-01 00:00:00.000", "2025-01-02 00:00:00.000", "hour", empty);
    expect(ch).toEqual(iso);
    expect(ch).toHaveLength(24);
    expect(ch[0].bucket).toBe("2025-01-01 00:00:00");
  });

  it("floors week buckets to Sunday like ClickHouse toStartOfWeek", () => {
    // 2025-01-01 is a Wednesday; the containing week starts Sunday 2024-12-29.
    const result = fillTimeBuckets(
      [{ bucket: "2025-01-05", value: 3 }],
      "2025-01-01T00:00:00.000Z",
      "2025-01-20T00:00:00.000Z",
      "week",
      empty,
    );
    expect(result.map((r) => r.bucket)).toEqual(["2024-12-29", "2025-01-05", "2025-01-12", "2025-01-19"]);
    expect(result[1].value).toBe(3);
  });

  it("generates month buckets date-only", () => {
    const result = fillTimeBuckets(
      [],
      "2025-01-15T00:00:00.000Z",
      "2025-04-01T00:00:00.000Z",
      "month",
      empty,
    );
    expect(result.map((r) => r.bucket)).toEqual(["2025-01-01", "2025-02-01", "2025-03-01"]);
  });

  it("falls back to raw rows when the range would exceed the bucket cap", () => {
    const rows = [{ bucket: "2025-06-01 00:00:00", value: 1 }];
    const result = fillTimeBuckets(
      rows,
      "2020-01-01T00:00:00.000Z",
      "2025-01-01T00:00:00.000Z",
      "hour",
      empty,
    );
    expect(result).toBe(rows);
  });

  it("returns rows unchanged for unparseable bounds", () => {
    const rows = [{ bucket: "2025-01-01 00:00:00", value: 1 }];
    expect(fillTimeBuckets(rows, "garbage", "2025-01-08T00:00:00.000Z", "day", empty)).toBe(rows);
  });
});
