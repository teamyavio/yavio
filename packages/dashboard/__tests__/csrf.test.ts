import { describe, expect, it } from "vitest";
import { validateCsrf } from "../lib/security/csrf";

// ── helpers ────────────────────────────────────────────────────────
function makeRequest(opts: {
  csrfHeader?: string | null;
  csrfCookie?: string | null;
  secureCookie?: string | null;
}) {
  const headers = new Headers();
  if (opts.csrfHeader) {
    headers.set("x-csrf-token", opts.csrfHeader);
  }

  const cookies: string[] = [];
  if (opts.csrfCookie) {
    cookies.push(`next-auth.csrf-token=${opts.csrfCookie}`);
  }
  if (opts.secureCookie) {
    cookies.push(`__Secure-next-auth.csrf-token=${opts.secureCookie}`);
  }
  if (cookies.length > 0) {
    headers.set("cookie", cookies.join("; "));
  }

  const url = "http://localhost:3000/api/test";
  // Use NextRequest-compatible structure
  const request = new Request(url, { headers });

  // NextRequest exposes cookies via .cookies — simulate it
  return {
    headers: request.headers,
    cookies: {
      get(name: string) {
        const raw = request.headers.get("cookie") ?? "";
        const match = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
        return match ? { value: match[1] } : undefined;
      },
    },
  } as Parameters<typeof validateCsrf>[0];
}

// ── tests ──────────────────────────────────────────────────────────
describe("validateCsrf", () => {
  it("returns true when header matches cookie token part", () => {
    const token = "abc123";
    const result = validateCsrf(
      makeRequest({
        csrfHeader: token,
        csrfCookie: `${token}|somehash`,
      }),
    );
    expect(result).toBe(true);
  });

  it("returns false when header does not match cookie token", () => {
    const result = validateCsrf(
      makeRequest({
        csrfHeader: "wrong-token",
        csrfCookie: "correct-token|somehash",
      }),
    );
    expect(result).toBe(false);
  });

  it("returns false when CSRF header is missing", () => {
    const result = validateCsrf(
      makeRequest({
        csrfHeader: null,
        csrfCookie: "token|hash",
      }),
    );
    expect(result).toBe(false);
  });

  it("returns false when CSRF cookie is missing", () => {
    const result = validateCsrf(
      makeRequest({
        csrfHeader: "token",
        csrfCookie: null,
      }),
    );
    expect(result).toBe(false);
  });

  it("returns false when both header and cookie are missing", () => {
    const result = validateCsrf(makeRequest({ csrfHeader: null, csrfCookie: null }));
    expect(result).toBe(false);
  });

  it("returns false when cookie has no pipe separator (no token part)", () => {
    // If cookie is just empty before pipe, token part is ""
    const result = validateCsrf(
      makeRequest({
        csrfHeader: "some-token",
        csrfCookie: "|hashonly",
      }),
    );
    expect(result).toBe(false);
  });

  it("falls back to __Secure- prefixed cookie", () => {
    const token = "secure-token";
    const result = validateCsrf(
      makeRequest({
        csrfHeader: token,
        csrfCookie: null,
        secureCookie: `${token}|hash`,
      }),
    );
    expect(result).toBe(true);
  });

  it("prefers non-secure cookie over secure cookie", () => {
    const result = validateCsrf(
      makeRequest({
        csrfHeader: "standard",
        csrfCookie: "standard|hash",
        secureCookie: "different|hash",
      }),
    );
    expect(result).toBe(true);
  });

  it("handles tokens with special characters", () => {
    const token = "a1b2c3d4-e5f6+g7h8=";
    const result = validateCsrf(
      makeRequest({
        csrfHeader: token,
        csrfCookie: `${token}|hash`,
      }),
    );
    expect(result).toBe(true);
  });

  it("is case-sensitive", () => {
    const result = validateCsrf(
      makeRequest({
        csrfHeader: "Token",
        csrfCookie: "token|hash",
      }),
    );
    expect(result).toBe(false);
  });
});
