import { ErrorCode } from "@yavio/shared/error-codes";
import { describe, expect, it } from "vitest";
import { createApiKeySchema, rotateApiKeySchema } from "../lib/api-key/validation";

describe("API key validation schemas", () => {
  describe("createApiKeySchema", () => {
    it("accepts empty object (optional name)", () => {
      const result = createApiKeySchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("accepts name up to 100 chars", () => {
      const result = createApiKeySchema.safeParse({ name: "Production Key" });
      expect(result.success).toBe(true);
    });

    it("rejects empty name string", () => {
      const result = createApiKeySchema.safeParse({ name: "" });
      expect(result.success).toBe(false);
    });

    it("rejects name longer than 100 chars", () => {
      const result = createApiKeySchema.safeParse({ name: "a".repeat(101) });
      expect(result.success).toBe(false);
    });
  });

  describe("rotateApiKeySchema", () => {
    it("accepts empty object (optional grace period)", () => {
      const result = rotateApiKeySchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("accepts grace period of 0 minutes", () => {
      const result = rotateApiKeySchema.safeParse({ gracePeriodMinutes: 0 });
      expect(result.success).toBe(true);
    });

    it("accepts grace period up to 1440 minutes (24h)", () => {
      const result = rotateApiKeySchema.safeParse({ gracePeriodMinutes: 1440 });
      expect(result.success).toBe(true);
    });

    it("rejects negative grace period", () => {
      const result = rotateApiKeySchema.safeParse({ gracePeriodMinutes: -1 });
      expect(result.success).toBe(false);
    });

    it("rejects grace period over 1440", () => {
      const result = rotateApiKeySchema.safeParse({ gracePeriodMinutes: 1441 });
      expect(result.success).toBe(false);
    });

    it("rejects non-integer grace period", () => {
      const result = rotateApiKeySchema.safeParse({ gracePeriodMinutes: 10.5 });
      expect(result.success).toBe(false);
    });
  });
});

describe("API key error codes", () => {
  it("defines all key operation error codes", () => {
    expect(ErrorCode.DASHBOARD.API_KEY_NOT_FOUND).toBe("YAVIO-3250");
    expect(ErrorCode.DASHBOARD.API_KEY_ALREADY_REVOKED).toBe("YAVIO-3251");
    expect(ErrorCode.DASHBOARD.INVALID_KEY_NAME).toBe("YAVIO-3252");
    expect(ErrorCode.DASHBOARD.INVALID_GRACE_PERIOD).toBe("YAVIO-3253");
  });
});
