import { describe, expect, it } from "vitest";
import { ErrorCode } from "../error-codes.js";
import type { ErrorCodeValue } from "../error-codes.js";

describe("ErrorCode", () => {
  const groups = Object.keys(ErrorCode) as (keyof typeof ErrorCode)[];

  it("has expected top-level groups", () => {
    expect(groups).toEqual(
      expect.arrayContaining([
        "SDK",
        "INGEST",
        "DASHBOARD",
        "INTELLIGENCE",
        "DB",
        "CLI",
        "INFRA",
      ]),
    );
  });

  it("every code matches YAVIO-NNNN format", () => {
    for (const group of groups) {
      const codes = Object.values(ErrorCode[group]);
      for (const code of codes) {
        expect(code).toMatch(/^YAVIO-\d{4}$/);
      }
    }
  });

  it("all codes are globally unique", () => {
    const seen = new Set<string>();
    for (const group of groups) {
      for (const code of Object.values(ErrorCode[group])) {
        expect(seen.has(code)).toBe(false);
        seen.add(code);
      }
    }
  });

  it("SDK codes are in the 1000–1999 range", () => {
    for (const code of Object.values(ErrorCode.SDK)) {
      const num = Number.parseInt(code.replace("YAVIO-", ""), 10);
      expect(num).toBeGreaterThanOrEqual(1000);
      expect(num).toBeLessThan(2000);
    }
  });

  it("INGEST codes are in the 2000–2999 range", () => {
    for (const code of Object.values(ErrorCode.INGEST)) {
      const num = Number.parseInt(code.replace("YAVIO-", ""), 10);
      expect(num).toBeGreaterThanOrEqual(2000);
      expect(num).toBeLessThan(3000);
    }
  });

  it("DASHBOARD codes are in the 3000–3999 range", () => {
    for (const code of Object.values(ErrorCode.DASHBOARD)) {
      const num = Number.parseInt(code.replace("YAVIO-", ""), 10);
      expect(num).toBeGreaterThanOrEqual(3000);
      expect(num).toBeLessThan(4000);
    }
  });

  it("INTELLIGENCE codes are in the 4000–4999 range", () => {
    for (const code of Object.values(ErrorCode.INTELLIGENCE)) {
      const num = Number.parseInt(code.replace("YAVIO-", ""), 10);
      expect(num).toBeGreaterThanOrEqual(4000);
      expect(num).toBeLessThan(5000);
    }
  });

  it("DB codes are in the 5000–5999 range", () => {
    for (const code of Object.values(ErrorCode.DB)) {
      const num = Number.parseInt(code.replace("YAVIO-", ""), 10);
      expect(num).toBeGreaterThanOrEqual(5000);
      expect(num).toBeLessThan(6000);
    }
  });

  it("CLI codes are in the 6000–6999 range", () => {
    for (const code of Object.values(ErrorCode.CLI)) {
      const num = Number.parseInt(code.replace("YAVIO-", ""), 10);
      expect(num).toBeGreaterThanOrEqual(6000);
      expect(num).toBeLessThan(7000);
    }
  });

  it("INFRA codes are in the 7000–7999 range", () => {
    for (const code of Object.values(ErrorCode.INFRA)) {
      const num = Number.parseInt(code.replace("YAVIO-", ""), 10);
      expect(num).toBeGreaterThanOrEqual(7000);
      expect(num).toBeLessThan(8000);
    }
  });

  it("ErrorCodeValue type accepts valid codes", () => {
    const code: ErrorCodeValue = ErrorCode.SDK.NO_API_KEY;
    expect(code).toBe("YAVIO-1000");
  });
});
