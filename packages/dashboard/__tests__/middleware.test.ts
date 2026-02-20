import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { securityHeaders } from "../lib/security/headers";

// ── mocks ──────────────────────────────────────────────────────────
vi.mock("@/lib/security/csrf", () => ({
  validateCsrf: vi.fn(() => false),
}));

vi.mock("@/lib/security/origin", () => ({
  validateOrigin: vi.fn(() => false),
}));

vi.mock("@yavio/shared/error-codes", () => ({
  ErrorCode: {
    DASHBOARD: {
      ORIGIN_VALIDATION_FAILED: "YAVIO-3001",
    },
  },
}));

import { validateCsrf } from "../lib/security/csrf";
import { validateOrigin } from "../lib/security/origin";

const mockValidateCsrf = validateCsrf as ReturnType<typeof vi.fn>;
const mockValidateOrigin = validateOrigin as ReturnType<typeof vi.fn>;

// ── helpers ────────────────────────────────────────────────────────
// NextRequest polyfill for vitest (outside of Next.js runtime)
function makeNextRequest(
  url: string,
  opts: {
    method?: string;
    cookies?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
) {
  const parsedUrl = new URL(url, "http://localhost:3000");
  const headers = new Headers(opts.headers ?? {});

  // Build cookie header from cookies map
  if (opts.cookies) {
    const cookieStr = Object.entries(opts.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    headers.set("cookie", cookieStr);
  }

  return {
    method: opts.method ?? "GET",
    nextUrl: parsedUrl,
    url: parsedUrl.toString(),
    headers,
    cookies: {
      get(name: string) {
        const raw = headers.get("cookie") ?? "";
        const match = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
        return match ? { value: match[1] } : undefined;
      },
    },
  } as Parameters<typeof import("../proxy")["proxy"]>[0];
}

// ── tests ──────────────────────────────────────────────────────────
describe("proxy middleware", () => {
  let proxyFn: typeof import("../proxy")["proxy"];

  beforeEach(async () => {
    vi.clearAllMocks();
    mockValidateCsrf.mockReturnValue(false);
    mockValidateOrigin.mockReturnValue(false);
    // Dynamic import to pick up fresh mocks
    const mod = await import("../proxy");
    proxyFn = mod.proxy;
  });

  // ── static assets bypass ─────────────────────────────────────────
  it("passes through static assets without security headers", () => {
    const res = proxyFn(makeNextRequest("http://localhost:3000/_next/static/chunk.js"));
    expect(res.headers.get("X-Frame-Options")).toBeNull();
  });

  it("passes through favicon", () => {
    const res = proxyFn(makeNextRequest("http://localhost:3000/favicon.ico"));
    expect(res.headers.get("X-Frame-Options")).toBeNull();
  });

  it("passes through files with extensions", () => {
    const res = proxyFn(makeNextRequest("http://localhost:3000/logo.svg"));
    expect(res.headers.get("X-Frame-Options")).toBeNull();
  });

  // ── security headers applied ─────────────────────────────────────
  it("applies all security headers to non-static responses", () => {
    const res = proxyFn(
      makeNextRequest("http://localhost:3000/dashboard", {
        cookies: { "authjs.session-token": "valid" },
      }),
    );

    for (const [key, value] of Object.entries(securityHeaders)) {
      expect(res.headers.get(key)).toBe(value);
    }
  });

  // ── origin + CSRF validation on mutating requests ────────────────
  it("blocks POST to non-auth API when origin and CSRF fail", () => {
    const res = proxyFn(
      makeNextRequest("http://localhost:3000/api/workspaces", { method: "POST" }),
    );
    expect(res.status).toBe(403);
  });

  it("blocks PUT requests when origin and CSRF fail", () => {
    const res = proxyFn(
      makeNextRequest("http://localhost:3000/api/workspaces/1", { method: "PUT" }),
    );
    expect(res.status).toBe(403);
  });

  it("blocks DELETE requests when origin and CSRF fail", () => {
    const res = proxyFn(
      makeNextRequest("http://localhost:3000/api/workspaces/1", { method: "DELETE" }),
    );
    expect(res.status).toBe(403);
  });

  it("blocks PATCH requests when origin and CSRF fail", () => {
    const res = proxyFn(
      makeNextRequest("http://localhost:3000/api/workspaces/1", { method: "PATCH" }),
    );
    expect(res.status).toBe(403);
  });

  it("allows mutating request when origin is valid", () => {
    mockValidateOrigin.mockReturnValue(true);
    const res = proxyFn(
      makeNextRequest("http://localhost:3000/api/workspaces", { method: "POST" }),
    );
    expect(res.status).not.toBe(403);
  });

  it("allows mutating request when CSRF is valid (even if origin fails)", () => {
    mockValidateOrigin.mockReturnValue(false);
    mockValidateCsrf.mockReturnValue(true);
    const res = proxyFn(
      makeNextRequest("http://localhost:3000/api/workspaces", { method: "POST" }),
    );
    expect(res.status).not.toBe(403);
  });

  it("allows GET requests without origin/CSRF check", () => {
    const res = proxyFn(
      makeNextRequest("http://localhost:3000/api/workspaces", {
        method: "GET",
        cookies: { "authjs.session-token": "valid" },
      }),
    );
    expect(res.status).not.toBe(403);
  });

  it("allows HEAD requests without origin/CSRF check", () => {
    const res = proxyFn(
      makeNextRequest("http://localhost:3000/api/workspaces", {
        method: "HEAD",
        cookies: { "authjs.session-token": "valid" },
      }),
    );
    expect(res.status).not.toBe(403);
  });

  it("allows OPTIONS requests without origin/CSRF check", () => {
    const res = proxyFn(
      makeNextRequest("http://localhost:3000/api/workspaces", {
        method: "OPTIONS",
        cookies: { "authjs.session-token": "valid" },
      }),
    );
    expect(res.status).not.toBe(403);
  });

  // ── NextAuth routes skip origin/CSRF ─────────────────────────────
  const nextAuthRoutes = [
    "/api/auth/callback/google",
    "/api/auth/callback/credentials",
    "/api/auth/csrf",
    "/api/auth/signin",
    "/api/auth/signout",
    "/api/auth/session",
    "/api/auth/providers",
    "/api/auth/error",
  ];

  for (const route of nextAuthRoutes) {
    it(`skips origin/CSRF for NextAuth route ${route}`, () => {
      const res = proxyFn(makeNextRequest(`http://localhost:3000${route}`, { method: "POST" }));
      expect(res.status).not.toBe(403);
    });
  }

  // ── custom auth routes ARE protected ──────────────────────────────
  const customAuthRoutes = [
    { path: "/api/auth/register", method: "POST" },
    { path: "/api/auth/forgot-password", method: "POST" },
    { path: "/api/auth/reset-password", method: "POST" },
    { path: "/api/auth/verify-email", method: "POST" },
    { path: "/api/auth/invite/abc123/accept", method: "POST" },
    { path: "/api/auth/account", method: "DELETE" },
  ];

  for (const { path, method } of customAuthRoutes) {
    it(`blocks ${method} ${path} when origin and CSRF fail`, () => {
      const res = proxyFn(makeNextRequest(`http://localhost:3000${path}`, { method }));
      expect(res.status).toBe(403);
    });

    it(`allows ${method} ${path} when origin is valid`, () => {
      mockValidateOrigin.mockReturnValue(true);
      const res = proxyFn(makeNextRequest(`http://localhost:3000${path}`, { method }));
      expect(res.status).not.toBe(403);
    });
  }

  // ── auth redirect ────────────────────────────────────────────────
  it("redirects unauthenticated users from protected pages to login", () => {
    const res = proxyFn(makeNextRequest("http://localhost:3000/dashboard"));
    expect(res.status).toBe(307);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/login");
    expect(location).toContain("callbackUrl=%2Fdashboard");
  });

  it("does not redirect authenticated users", () => {
    const res = proxyFn(
      makeNextRequest("http://localhost:3000/dashboard", {
        cookies: { "authjs.session-token": "some-token" },
      }),
    );
    expect(res.status).not.toBe(307);
  });

  it("does not redirect authenticated users with secure cookie", () => {
    const res = proxyFn(
      makeNextRequest("http://localhost:3000/dashboard", {
        cookies: { "__Secure-authjs.session-token": "some-token" },
      }),
    );
    expect(res.status).not.toBe(307);
  });

  // ── public paths bypass auth redirect ────────────────────────────
  const publicPaths = [
    "/login",
    "/register",
    "/forgot-password",
    "/reset-password",
    "/verify-email",
  ];

  for (const path of publicPaths) {
    it(`does not redirect unauthenticated users from ${path}`, () => {
      const res = proxyFn(makeNextRequest(`http://localhost:3000${path}`));
      expect(res.status).not.toBe(307);
    });
  }

  it("does not redirect from root path", () => {
    const res = proxyFn(makeNextRequest("http://localhost:3000/"));
    expect(res.status).not.toBe(307);
  });

  it("does not redirect from API routes", () => {
    const res = proxyFn(makeNextRequest("http://localhost:3000/api/health", { method: "GET" }));
    expect(res.status).not.toBe(307);
  });
});
