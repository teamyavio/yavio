import { describe, expect, it } from "vitest";
import { addMonths, monthsToProcess, partitionId, ranToday } from "../../stats/months.js";

const NOW = new Date("2026-10-14T03:00:00Z");

describe("monthsToProcess (#85)", () => {
  it("recomputes the previous and the current month every day", () => {
    expect(monthsToProcess(new Date("2026-10-13T03:00:00Z"), NOW, "2026-01-01")).toEqual([
      "2026-09-01",
      "2026-10-01",
    ]);
  });

  it("catches up every month since the last successful run", () => {
    expect(monthsToProcess(new Date("2026-07-20T03:00:00Z"), NOW, "2026-01-01")).toEqual([
      "2026-07-01",
      "2026-08-01",
      "2026-09-01",
      "2026-10-01",
    ]);
  });

  it("backfills every month that still has events on the first run", () => {
    expect(monthsToProcess(null, NOW, "2026-07-01")).toEqual([
      "2026-07-01",
      "2026-08-01",
      "2026-09-01",
      "2026-10-01",
    ]);
  });

  it("still covers the previous month on a first run with no or only recent events", () => {
    expect(monthsToProcess(null, NOW, null)).toEqual(["2026-09-01", "2026-10-01"]);
    expect(monthsToProcess(null, NOW, "2026-10-01")).toEqual(["2026-09-01", "2026-10-01"]);
  });

  it("crosses year boundaries", () => {
    expect(monthsToProcess(null, new Date("2027-01-02T00:00:00Z"), "2026-11-01")).toEqual([
      "2026-11-01",
      "2026-12-01",
      "2027-01-01",
    ]);
  });
});

describe("helpers", () => {
  it("adds months across a year", () => {
    expect(addMonths("2026-12-01", 1)).toBe("2027-01-01");
    expect(addMonths("2026-01-01", -1)).toBe("2025-12-01");
  });

  it("names partitions like toYYYYMM", () => {
    expect(partitionId("2026-10-01")).toBe(202610);
  });

  it("runs at most once per UTC day", () => {
    expect(ranToday(new Date("2026-10-14T00:00:01Z"), NOW)).toBe(true);
    expect(ranToday(new Date("2026-10-13T23:59:59Z"), NOW)).toBe(false);
    expect(ranToday(null, NOW)).toBe(false);
  });
});
