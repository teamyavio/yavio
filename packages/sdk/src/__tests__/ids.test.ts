import { describe, expect, it } from "vitest";
import {
  deriveSessionId,
  generateEventId,
  generateSessionId,
  generateTraceId,
} from "../core/ids.js";

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

  describe("deriveSessionId", () => {
    it("starts with ses_ prefix", () => {
      expect(deriveSessionId("mcp-session-123")).toMatch(/^ses_/);
    });

    it("has correct length (ses_ + 21 chars)", () => {
      expect(deriveSessionId("mcp-session-123")).toHaveLength(4 + 21);
    });

    it("is deterministic — same input produces same output", () => {
      const id1 = deriveSessionId("mcp-session-abc");
      const id2 = deriveSessionId("mcp-session-abc");
      expect(id1).toBe(id2);
    });

    it("produces different IDs for different inputs", () => {
      const id1 = deriveSessionId("mcp-session-alpha");
      const id2 = deriveSessionId("mcp-session-beta");
      expect(id1).not.toBe(id2);
    });

    it("uses only URL-safe characters", () => {
      // base64url alphabet: A-Z, a-z, 0-9, -, _
      const id = deriveSessionId("test-input");
      const suffix = id.slice(4); // strip ses_ prefix
      expect(suffix).toMatch(/^[A-Za-z0-9_-]+$/);
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
