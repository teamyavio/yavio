import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type JwtPayload, jwtSign, jwtVerify } from "../lib/jwt.js";

const SECRET = "test-jwt-secret";

function makePayload(overrides: Partial<JwtPayload> = {}): JwtPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    pid: "project-1",
    wid: "workspace-1",
    tid: "trace-1",
    sid: "session-1",
    iat: now,
    exp: now + 900,
    ...overrides,
  };
}

describe("JWT", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("signs and verifies a valid token", () => {
    const payload = makePayload();
    const token = jwtSign(payload, SECRET);
    const decoded = jwtVerify(token, SECRET);
    expect(decoded).toEqual(payload);
  });

  it("token starts with eyJ (base64url-encoded JSON header)", () => {
    const token = jwtSign(makePayload(), SECRET);
    expect(token.startsWith("eyJ")).toBe(true);
  });

  it("returns null for wrong secret", () => {
    const token = jwtSign(makePayload(), SECRET);
    expect(jwtVerify(token, "wrong-secret")).toBeNull();
  });

  it("returns null for tampered payload", () => {
    const token = jwtSign(makePayload(), SECRET);
    const parts = token.split(".");
    // Tamper with payload
    parts[1] = Buffer.from(JSON.stringify({ pid: "hacked" })).toString("base64url");
    expect(jwtVerify(parts.join("."), SECRET)).toBeNull();
  });

  it("returns null for expired token", () => {
    const payload = makePayload({ exp: Math.floor(Date.now() / 1000) + 10 });
    const token = jwtSign(payload, SECRET);

    vi.advanceTimersByTime(11_000);
    expect(jwtVerify(token, SECRET)).toBeNull();
  });

  it("returns null for malformed token (wrong number of parts)", () => {
    expect(jwtVerify("abc.def", SECRET)).toBeNull();
    expect(jwtVerify("abc.def.ghi.jkl", SECRET)).toBeNull();
  });

  it("returns null when required claims are missing", () => {
    // Manually craft a token missing required claims
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ foo: "bar", exp: 9999999999 })).toString(
      "base64url",
    );
    const { createHmac } = require("node:crypto");
    const sig = createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
    expect(jwtVerify(`${header}.${payload}.${sig}`, SECRET)).toBeNull();
  });

  it("preserves all claims in round-trip", () => {
    const payload = makePayload({
      pid: "p-123",
      wid: "w-456",
      tid: "t-789",
      sid: "s-abc",
    });
    const token = jwtSign(payload, SECRET);
    const decoded = jwtVerify(token, SECRET);
    expect(decoded?.pid).toBe("p-123");
    expect(decoded?.wid).toBe("w-456");
    expect(decoded?.tid).toBe("t-789");
    expect(decoded?.sid).toBe("s-abc");
  });
});
