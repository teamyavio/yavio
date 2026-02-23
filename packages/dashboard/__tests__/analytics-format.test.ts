import {
  formatCurrency,
  formatLatency,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  granularityToFunction,
} from "@/lib/analytics/format";
import { describe, expect, it } from "vitest";

describe("formatNumber", () => {
  it("formats numbers under 1K as-is", () => {
    expect(formatNumber(42)).toBe("42");
    expect(formatNumber(999)).toBe("999");
  });

  it("formats thousands with K suffix", () => {
    expect(formatNumber(1500)).toBe("1.5K");
    expect(formatNumber(10_000)).toBe("10.0K");
  });

  it("formats millions with M suffix", () => {
    expect(formatNumber(1_500_000)).toBe("1.5M");
    expect(formatNumber(10_000_000)).toBe("10.0M");
  });
});

describe("formatPercent", () => {
  it("formats decimal as percentage", () => {
    expect(formatPercent(0.952)).toBe("95.2%");
    expect(formatPercent(0.5)).toBe("50.0%");
    expect(formatPercent(1)).toBe("100.0%");
  });

  it("respects decimal places", () => {
    expect(formatPercent(0.9523, 2)).toBe("95.23%");
  });
});

describe("formatLatency", () => {
  it("formats sub-millisecond as microseconds", () => {
    expect(formatLatency(0.5)).toBe("500us");
  });

  it("formats milliseconds", () => {
    expect(formatLatency(42)).toBe("42ms");
    expect(formatLatency(999)).toBe("999ms");
  });

  it("formats seconds", () => {
    expect(formatLatency(1500)).toBe("1.50s");
    expect(formatLatency(3200)).toBe("3.20s");
  });
});

describe("formatCurrency", () => {
  it("formats USD by default", () => {
    expect(formatCurrency(1234.5)).toBe("$1,234.50");
  });

  it("formats with custom currency", () => {
    const result = formatCurrency(1000, "EUR");
    expect(result).toContain("1,000");
  });
});

describe("formatRelativeTime", () => {
  it("formats seconds ago", () => {
    const date = new Date(Date.now() - 30_000);
    expect(formatRelativeTime(date)).toBe("30s ago");
  });

  it("formats minutes ago", () => {
    const date = new Date(Date.now() - 5 * 60_000);
    expect(formatRelativeTime(date)).toBe("5m ago");
  });

  it("formats hours ago", () => {
    const date = new Date(Date.now() - 3 * 3_600_000);
    expect(formatRelativeTime(date)).toBe("3h ago");
  });

  it("formats days ago", () => {
    const date = new Date(Date.now() - 7 * 86_400_000);
    expect(formatRelativeTime(date)).toBe("7d ago");
  });

  it("handles ISO string input", () => {
    const date = new Date(Date.now() - 2 * 3_600_000).toISOString();
    expect(formatRelativeTime(date)).toBe("2h ago");
  });
});

describe("granularityToFunction", () => {
  it("maps correctly", () => {
    expect(granularityToFunction("hour")).toBe("toStartOfHour");
    expect(granularityToFunction("day")).toBe("toStartOfDay");
    expect(granularityToFunction("week")).toBe("toStartOfWeek");
    expect(granularityToFunction("month")).toBe("toStartOfMonth");
  });
});
