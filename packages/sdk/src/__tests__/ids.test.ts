import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deriveCustomSessionId,
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

  describe("deriveCustomSessionId (#144)", () => {
    it("is ses_ + 21 base64url characters, stable for one API key and key", () => {
      const id = deriveCustomSessionId("yav_project_a", "conv-1");
      expect(id).toMatch(/^ses_[A-Za-z0-9_-]{21}$/);
      expect(deriveCustomSessionId("yav_project_a", "conv-1")).toBe(id);
    });

    it("is the HMAC-SHA256 keyed with the API key over 'custom\\0' + key", () => {
      const expected = `ses_${createHmac("sha256", "yav_project_a").update("custom\u0000conv-1").digest("base64url").slice(0, 21)}`;
      expect(deriveCustomSessionId("yav_project_a", "conv-1")).toBe(expected);
    });

    it("differs per API key, per key, and from deriveSessionId() of the same text", () => {
      const id = deriveCustomSessionId("yav_project_a", "max@example.com");
      expect(deriveCustomSessionId("yav_project_b", "max@example.com")).not.toBe(id);
      expect(deriveCustomSessionId("yav_project_a", "max@example.org")).not.toBe(id);
      // An unkeyed hash of a guessable value is a pseudonym anyone can recompute.
      expect(deriveSessionId("max@example.com")).not.toBe(id);
      expect(deriveSessionId("custom\u0000max@example.com")).not.toBe(id);
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
