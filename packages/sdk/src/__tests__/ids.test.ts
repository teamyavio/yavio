import { describe, expect, it } from "vitest";
import { generateEventId, generateSessionId, generateTraceId } from "../core/ids.js";

describe("ID generation", () => {
  describe("generateSessionId", () => {
    it("starts with ses_ prefix", () => {
      expect(generateSessionId()).toMatch(/^ses_/);
    });

    it("has correct length (ses_ + 21 chars)", () => {
      expect(generateSessionId()).toHaveLength(4 + 21);
    });

    it("produces unique IDs", () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateSessionId()));
      expect(ids.size).toBe(100);
    });
  });

  describe("generateTraceId", () => {
    it("starts with tr_ prefix", () => {
      expect(generateTraceId()).toMatch(/^tr_/);
    });

    it("has correct length (tr_ + 21 chars)", () => {
      expect(generateTraceId()).toHaveLength(3 + 21);
    });

    it("produces unique IDs", () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()));
      expect(ids.size).toBe(100);
    });
  });

  describe("generateEventId", () => {
    it("produces a valid UUID v4", () => {
      const id = generateEventId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it("produces unique IDs", () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateEventId()));
      expect(ids.size).toBe(100);
    });
  });
});
