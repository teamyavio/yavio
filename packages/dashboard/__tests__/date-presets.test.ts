import { describe, expect, it } from "vitest";
import { DATE_PRESETS } from "../lib/analytics/date-presets";

describe("date range presets (#85)", () => {
  it("offer 6 and 12 months", () => {
    expect(DATE_PRESETS.map((p) => p.label)).toEqual(["24h", "7d", "30d", "3m", "6m", "12m"]);
  });

  it("never reach past the 13-month retention window", () => {
    // Any 13 consecutive months last more than 366 days, so a range of at
    // most a (leap) year always lies inside the window.
    for (const p of DATE_PRESETS) expect(p.days).toBeLessThanOrEqual(366);
  });
});
