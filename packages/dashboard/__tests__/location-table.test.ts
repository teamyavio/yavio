import { describe, expect, it } from "vitest";
import { regionSummary } from "../components/analytics/location-table";

const country = (regions: Array<string | null>) => ({
  countryCode: "DE",
  toolCalls: regions.length,
  users: 1,
  regions: regions.map((region) => ({ region, toolCalls: 1, users: 1 })),
});

// #129: the Region cell of a country row. The Unknown bucket is not a region.
describe("regionSummary", () => {
  it("names a single bucket, known or Unknown", () => {
    expect(regionSummary(country(["Hesse"]))).toBe("Hesse");
    expect(regionSummary(country([null]))).toBe("Unknown");
  });

  it("counts only known regions and adds Unknown when some calls had none", () => {
    expect(regionSummary(country(["Hesse", "Bavaria", "Saxony", "Berlin", null]))).toBe(
      "4 regions + Unknown",
    );
    expect(regionSummary(country(["Hesse", null]))).toBe("1 region + Unknown");
    expect(regionSummary(country(["Hesse", "Bavaria"]))).toBe("2 regions");
  });
});
