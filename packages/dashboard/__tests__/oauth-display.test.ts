import { describe, expect, it } from "vitest";
import { sanitizeClientName } from "../lib/oauth/display";

/**
 * Client names come from attacker-controlled registration input and become
 * the headline of the consent card.
 */
describe("sanitizeClientName", () => {
  it("keeps ordinary names untouched", () => {
    expect(sanitizeClientName("Claude")).toBe("Claude");
    expect(sanitizeClientName("ChatGPT Connector (beta)")).toBe("ChatGPT Connector (beta)");
  });

  it("strips control characters and collapses newlines", () => {
    expect(sanitizeClientName("Yavio\n\n\n\n\n\n\n\n\n\nofficial")).toBe("Yavio official");
    expect(sanitizeClientName("bad name\u001b[31m")).toBe("bad name [31m");
  });

  it("strips bidi overrides and zero-width characters used to disguise text", () => {
    expect(sanitizeClientName("safe\u202eevil")).toBe("safe evil");
    expect(sanitizeClientName("a\u200bb\u2066c\u2069d")).toBe("a b c d");
  });

  it("caps the length so the consent card cannot be pushed out of view", () => {
    expect(sanitizeClientName("x".repeat(5000))).toHaveLength(120);
  });

  it("returns null for empty, whitespace-only and non-strings", () => {
    expect(sanitizeClientName("")).toBeNull();
    expect(sanitizeClientName("   \n  ")).toBeNull();
    expect(sanitizeClientName(null)).toBeNull();
    expect(sanitizeClientName(undefined)).toBeNull();
    expect(sanitizeClientName(42 as unknown as string)).toBeNull();
  });
});
