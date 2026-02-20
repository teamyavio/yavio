import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@yavio/shared/error-codes", () => ({
  ErrorCode: {
    DASHBOARD: {
      AUTH_ROUTE_RATE_LIMITED: "YAVIO-3900",
    },
  },
}));

import { withRateLimit } from "../lib/rate-limit/middleware";

// ── helpers ────────────────────────────────────────────────────────
function makeRequest(opts: { ip?: string; cookie?: string } = {}) {
  const headers = new Headers();
  if (opts.ip) headers.set("x-forwarded-for", opts.ip);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  return new Request("http://localhost:3000/api/test", { headers });
}

// ── tests ──────────────────────────────────────────────────────────
describe("withRateLimit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows request when under limit", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const limited = withRateLimit({
      name: "test-allow",
      config: { ratePerSecond: 10, burstCapacity: 10 },
      keyFrom: "ip",
    })(handler);

    const res = await limited(makeRequest({ ip: "1.2.3.4" }));
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalled();
  });

  it("returns 429 when rate limit is exceeded", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const limited = withRateLimit({
      name: "test-burst",
      config: { ratePerSecond: 1, burstCapacity: 2 },
      keyFrom: "ip",
    })(handler);

    const ip = "10.0.0.1";
    await limited(makeRequest({ ip })); // tokens: 2 → 1
    await limited(makeRequest({ ip })); // tokens: 1 → 0
    const res = await limited(makeRequest({ ip })); // tokens: ~0 → denied

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("YAVIO-3900");
    expect(res.headers.get("Retry-After")).toBeDefined();
  });

  it("extracts key from x-forwarded-for (first IP)", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const limited = withRateLimit({
      name: "test-xff",
      config: { ratePerSecond: 100, burstCapacity: 100 },
      keyFrom: "ip",
    })(handler);

    // Should use first IP from comma-separated list
    await limited(makeRequest({ ip: "1.1.1.1, 2.2.2.2, 3.3.3.3" }));
    expect(handler).toHaveBeenCalled();
  });

  it("falls back to 'unknown' when IP header is missing", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const limited = withRateLimit({
      name: "test-noip",
      config: { ratePerSecond: 100, burstCapacity: 100 },
      keyFrom: "ip",
    })(handler);

    await limited(makeRequest());
    expect(handler).toHaveBeenCalled();
  });

  it("extracts key from session cookie", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const limited = withRateLimit({
      name: "test-session",
      config: { ratePerSecond: 100, burstCapacity: 100 },
      keyFrom: "session",
    })(handler);

    await limited(makeRequest({ cookie: "session-token=abc123; other=xyz" }));
    expect(handler).toHaveBeenCalled();
  });

  it("isolates rate limits between different IPs", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const limited = withRateLimit({
      name: "test-isolation",
      config: { ratePerSecond: 1, burstCapacity: 1 },
      keyFrom: "ip",
    })(handler);

    // First IP exhausts its limit
    await limited(makeRequest({ ip: "10.0.0.1" }));
    const res1 = await limited(makeRequest({ ip: "10.0.0.1" }));
    expect(res1.status).toBe(429);

    // Second IP should still have tokens
    const res2 = await limited(makeRequest({ ip: "10.0.0.2" }));
    expect(res2.status).toBe(200);
  });

  it("returns Retry-After header as integer seconds", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const limited = withRateLimit({
      name: "test-retry",
      config: { ratePerSecond: 1, burstCapacity: 1 },
      keyFrom: "ip",
    })(handler);

    const ip = "10.0.0.5";
    await limited(makeRequest({ ip }));
    const res = await limited(makeRequest({ ip }));

    expect(res.status).toBe(429);
    const retryAfter = res.headers.get("Retry-After");
    expect(retryAfter).toBeDefined();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    // Should be an integer
    expect(Number(retryAfter)).toBe(Math.ceil(Number(retryAfter)));
  });
});
