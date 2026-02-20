import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateOrigin } from "../lib/security/origin";

// ── helpers ────────────────────────────────────────────────────────
function makeRequest(origin: string | null) {
  const headers = new Headers();
  if (origin) {
    headers.set("origin", origin);
  }
  return {
    headers,
  } as Parameters<typeof validateOrigin>[0];
}

// ── tests ──────────────────────────────────────────────────────────
describe("validateOrigin", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    Reflect.deleteProperty(process.env, "NEXTAUTH_URL");
    Reflect.deleteProperty(process.env, "APP_URL");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("accepts same-host origin (localhost default)", () => {
    const result = validateOrigin(makeRequest("http://localhost:3000"));
    expect(result).toBe(true);
  });

  it("accepts same-host origin with NEXTAUTH_URL set", () => {
    process.env.NEXTAUTH_URL = "https://app.yavio.dev";
    const result = validateOrigin(makeRequest("https://app.yavio.dev"));
    expect(result).toBe(true);
  });

  it("accepts same host on different port when only host matches", () => {
    // URL.host includes port, so different ports should be rejected
    process.env.NEXTAUTH_URL = "https://app.yavio.dev:3000";
    const result = validateOrigin(makeRequest("https://app.yavio.dev:4000"));
    expect(result).toBe(false);
  });

  it("falls back to APP_URL when NEXTAUTH_URL is not set", () => {
    process.env.APP_URL = "https://dashboard.yavio.dev";
    const result = validateOrigin(makeRequest("https://dashboard.yavio.dev"));
    expect(result).toBe(true);
  });

  it("prefers NEXTAUTH_URL over APP_URL", () => {
    process.env.NEXTAUTH_URL = "https://auth.yavio.dev";
    process.env.APP_URL = "https://other.yavio.dev";
    const result = validateOrigin(makeRequest("https://auth.yavio.dev"));
    expect(result).toBe(true);
  });

  it("rejects different host", () => {
    process.env.NEXTAUTH_URL = "https://app.yavio.dev";
    const result = validateOrigin(makeRequest("https://evil.com"));
    expect(result).toBe(false);
  });

  it("rejects missing origin header", () => {
    const result = validateOrigin(makeRequest(null));
    expect(result).toBe(false);
  });

  it("rejects malformed origin URL", () => {
    const result = validateOrigin(makeRequest("not-a-url"));
    expect(result).toBe(false);
  });

  it("rejects subdomain mismatch", () => {
    process.env.NEXTAUTH_URL = "https://app.yavio.dev";
    const result = validateOrigin(makeRequest("https://evil.app.yavio.dev"));
    expect(result).toBe(false);
  });

  it("allows same host with different scheme", () => {
    // URL.host only compares host:port, not scheme
    process.env.NEXTAUTH_URL = "http://localhost:3000";
    const result = validateOrigin(makeRequest("https://localhost:3000"));
    expect(result).toBe(true);
  });

  it("defaults to localhost:3000 when no env vars set", () => {
    const result = validateOrigin(makeRequest("http://localhost:3000"));
    expect(result).toBe(true);
  });
});
