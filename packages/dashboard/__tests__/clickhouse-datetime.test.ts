import { parseUtc } from "@/lib/clickhouse/datetime";
import { describe, expect, it } from "vitest";

describe("parseUtc (#148 review round 4)", () => {
  it("reads a ClickHouse datetime as UTC, whatever the host's zone", () => {
    expect(parseUtc("2026-07-16 15:30:56.202").toISOString()).toBe("2026-07-16T15:30:56.202Z");
    expect(parseUtc("2026-07-16 15:30:56").toISOString()).toBe("2026-07-16T15:30:56.000Z");
    expect(parseUtc("2026-07-16T15:30:56").toISOString()).toBe("2026-07-16T15:30:56.000Z");
  });

  it("passes a string with a zone, and a Date, through", () => {
    expect(parseUtc("2026-07-16T15:30:56.202Z").toISOString()).toBe("2026-07-16T15:30:56.202Z");
    expect(parseUtc("2026-07-16T17:30:56+02:00").toISOString()).toBe("2026-07-16T15:30:56.000Z");
    const date = new Date("2026-07-16T15:30:56.202Z");
    expect(parseUtc(date)).toBe(date);
  });

  it("gives an invalid Date for input it cannot read, for the caller to decide about", () => {
    expect(Number.isNaN(parseUtc("not a time").getTime())).toBe(true);
  });
});
