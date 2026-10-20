import { describe, expect, it } from "vitest";
import { MAX_REGION_LENGTH, normalizeRegionName } from "../geo.js";

describe("normalizeRegionName (#127, #128)", () => {
  it.each([
    ["North Rhine-Westphalia", "North Rhine-Westphalia"],
    ["State of Berlin", "State of Berlin"],
    ["  Lower   Saxony ", "Lower Saxony"],
    ["Baden-Württemberg", "Baden-Württemberg"],
    ["Côte d’Azur", "Côte d'Azur"],
    ["Côte d‘Azur", "Côte d'Azur"],
    ["Saxony‐Anhalt", "Saxony-Anhalt"],
    ["Saxony−Anhalt", "Saxony-Anhalt"],
    ["Trentino-Alto Adige/Südtirol", "Trentino-Alto Adige/Südtirol"],
    ["Saint Kitts & Nevis", "Saint Kitts & Nevis"],
    ["Washington, D.C.", "Washington, D.C."],
    ["Sakha (Yakutia)", "Sakha (Yakutia)"],
    ["Pla de l·Estany", "Pla de l·Estany"],
    ["Oʻahu", "Oʻahu"], // the okina is a letter, not an apostrophe: kept
    ["東京都", "東京都"],
  ])("%j -> %j", (input, expected) => {
    expect(normalizeRegionName(input)).toBe(expected);
  });

  it.each([
    ["Duisburg 47051"],
    ["me@example.com"],
    ["Hes\u0007se"],
    ["Hesse\n"],
    ["Lower\tSaxony"],
    [""],
    ["   "],
    ["-.,"],
    ["Hesse; DROP"],
    ["x".repeat(MAX_REGION_LENGTH + 1)],
    ["x".repeat(MAX_REGION_LENGTH * 4 + 1)],
  ])("%j -> null", (input) => {
    expect(normalizeRegionName(input)).toBeNull();
  });

  it("keeps exactly MAX_REGION_LENGTH characters, measured after normalising", () => {
    expect(normalizeRegionName("x".repeat(MAX_REGION_LENGTH))).toBe("x".repeat(MAX_REGION_LENGTH));
    expect(normalizeRegionName(` ${"x".repeat(MAX_REGION_LENGTH)}  `)).toBe(
      "x".repeat(MAX_REGION_LENGTH),
    );
  });
});
