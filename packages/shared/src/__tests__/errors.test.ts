import { describe, expect, it } from "vitest";
import { ErrorCode } from "../error-codes.js";
import { YavioError, isYavioError } from "../errors.js";

describe("YavioError", () => {
  it("extends Error", () => {
    const err = new YavioError(ErrorCode.SDK.NO_API_KEY, "missing key", 401);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(YavioError);
  });

  it("sets name to YavioError", () => {
    const err = new YavioError(ErrorCode.SDK.NO_API_KEY, "msg", 400);
    expect(err.name).toBe("YavioError");
  });

  it("stores code, message, and status", () => {
    const err = new YavioError(ErrorCode.INGEST.MISSING_AUTH_HEADER, "Auth header required", 401);
    expect(err.code).toBe("YAVIO-2000");
    expect(err.message).toBe("Auth header required");
    expect(err.status).toBe(401);
  });

  it("stores optional metadata", () => {
    const meta = { slug: "my-workspace" };
    const err = new YavioError(ErrorCode.DASHBOARD.WORKSPACE_SLUG_EXISTS, "exists", 409, meta);
    expect(err.metadata).toEqual(meta);
  });

  it("metadata is undefined when not provided", () => {
    const err = new YavioError(ErrorCode.SDK.NO_API_KEY, "msg", 400);
    expect(err.metadata).toBeUndefined();
  });

  describe("toJSON()", () => {
    it("serializes without requestId or metadata", () => {
      const err = new YavioError(ErrorCode.SDK.NO_API_KEY, "no key", 401);
      expect(err.toJSON()).toEqual({
        code: "YAVIO-1000",
        message: "no key",
        status: 401,
      });
    });

    it("includes requestId when provided", () => {
      const err = new YavioError(ErrorCode.SDK.NO_API_KEY, "no key", 401);
      const json = err.toJSON("req-123");
      expect(json).toEqual({
        code: "YAVIO-1000",
        message: "no key",
        status: 401,
        requestId: "req-123",
      });
    });

    it("includes metadata when present", () => {
      const err = new YavioError(ErrorCode.DASHBOARD.WORKSPACE_SLUG_EXISTS, "exists", 409, {
        slug: "test",
      });
      expect(err.toJSON()).toEqual({
        code: "YAVIO-3150",
        message: "exists",
        status: 409,
        metadata: { slug: "test" },
      });
    });

    it("includes both requestId and metadata", () => {
      const err = new YavioError(ErrorCode.INGEST.INTERNAL_ERROR, "boom", 500, { detail: "oops" });
      const json = err.toJSON("req-456");
      expect(json).toEqual({
        code: "YAVIO-2999",
        message: "boom",
        status: 500,
        requestId: "req-456",
        metadata: { detail: "oops" },
      });
    });
  });
});

describe("isYavioError()", () => {
  it("returns true for YavioError instances", () => {
    const err = new YavioError(ErrorCode.SDK.NO_API_KEY, "msg", 400);
    expect(isYavioError(err)).toBe(true);
  });

  it("returns false for plain Error", () => {
    expect(isYavioError(new Error("nope"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isYavioError(null)).toBe(false);
    expect(isYavioError(undefined)).toBe(false);
    expect(isYavioError("string")).toBe(false);
    expect(isYavioError(42)).toBe(false);
    expect(isYavioError({ code: "YAVIO-1000" })).toBe(false);
  });
});
