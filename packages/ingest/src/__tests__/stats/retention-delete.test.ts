import { describe, expect, it } from "vitest";
import { retentionDelete, retentionFloors } from "../../stats/queries.js";

const NOW = new Date("2026-10-14T03:00:00Z");

describe("retentionDelete (#93)", () => {
  it("is null when every project keeps the platform window", () => {
    expect(retentionDelete([{ id: "a", retentionMonths: 13 }], NOW)).toBeNull();
  });

  it("is one statement with one branch per retention, for all shorter projects", () => {
    const st = retentionDelete(
      [
        { id: "a", retentionMonths: 6 },
        { id: "b", retentionMonths: 2 },
        { id: "c", retentionMonths: 6 },
        { id: "d", retentionMonths: 13 },
      ],
      NOW,
    );
    expect(st?.query.match(/ALTER TABLE events DELETE/g)).toHaveLength(1);
    expect(st?.query.match(/project_id IN/g)).toHaveLength(2);
    expect(st?.params).toEqual({
      now: "2026-10-14 03:00:00",
      ids0: ["b"],
      months0: 2,
      ids1: ["a", "c"],
      months1: 6,
    });
    // Same expression as the TTL: counted from collection.
    expect(st?.query).toContain("least(toDateTime(timestamp), toDateTime(ingested_at))");
  });
});

/** ClickHouse's `- toIntervalMonth(n)`: clamps to the month's last day (Mar 31 - 1 = Feb 28). */
function minusMonths(d: Date, n: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() - n;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      y,
      m,
      Math.min(d.getUTCDate(), lastDay),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
    ),
  );
}

describe("retentionFloors (#93)", () => {
  it("is start(M + 2 - R) for projects below the platform window, nothing for the rest", () => {
    expect(
      retentionFloors(
        [
          { id: "two", retentionMonths: 2 },
          { id: "six", retentionMonths: 6 },
          { id: "twelve", retentionMonths: 12 },
          { id: "default", retentionMonths: 13 },
        ],
        "2026-03-01",
      ),
    ).toEqual({
      floorProjects: ["two", "six", "twelve"],
      floorDates: ["2026-03-01", "2025-11-01", "2025-05-01"],
    });
  });

  it("is never reached by a delete before the month's last recompute", () => {
    // Month M is last recomputed on the last day of M + 1; the delete then
    // cuts at that day minus R months, which is before the floor.
    for (const r of [2, 3, 6, 12]) {
      const [floor] = retentionFloors([{ id: "p", retentionMonths: r }], "2026-02-01").floorDates;
      const lastRecompute = new Date(Date.UTC(2026, 2, 31, 23, 59, 59));
      expect(minusMonths(lastRecompute, r).getTime()).toBeLessThan(
        Date.parse(`${floor}T00:00:00Z`),
      );
    }
  });
});
