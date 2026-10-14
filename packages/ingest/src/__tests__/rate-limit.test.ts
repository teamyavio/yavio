import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../index.js";
import type { ApiKeyResolver } from "../lib/api-key-resolver.js";
import { RateLimiter } from "../lib/rate-limiter.js";

const TEST_KEY = "yav_abc123def456abc123def456abc123de";
const TEST_PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const TEST_WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";

function mockDb() {
  return { execute: async () => [{ "?column?": 1 }] } as unknown as Database;
}

function mockClickHouse() {
  return { ping: async () => ({ success: true }) } as unknown as ClickHouseClient;
}

function mockApiKeyResolver() {
  return {
    resolve: async () => ({ projectId: TEST_PROJECT_ID, workspaceId: TEST_WORKSPACE_ID }),
    clearCache: () => {},
  } as unknown as ApiKeyResolver;
}

function makeEvent() {
  return {
    event_id: randomUUID(),
    event_type: "track",
    trace_id: "trace-1",
    session_id: "session-1",
    timestamp: new Date().toISOString(),
    source: "server",
  };
}

interface AppOptions {
  rateLimiter: RateLimiter;
  trustProxy?: string[];
  resolve?: (token: string) => Promise<{ projectId: string; workspaceId: string } | null>;
}

async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const resolver = opts.resolve
    ? ({ resolve: opts.resolve, clearCache: () => {} } as unknown as ApiKeyResolver)
    : mockApiKeyResolver();
  return createApp({
    db: mockDb(),
    clickhouse: mockClickHouse(),
    apiKeyResolver: resolver,
    jwtSecret: "test-secret",
    rateLimiter: opts.rateLimiter,
    trustProxy: opts.trustProxy,
    logger: false,
  });
}

function authedEvents(app: FastifyInstance, remoteAddress = "198.51.100.1") {
  return app.inject({
    method: "POST",
    url: "/v1/events",
    remoteAddress,
    headers: { authorization: `Bearer ${TEST_KEY}` },
    payload: { events: [makeEvent()] },
  });
}

describe("Rate limit plugin", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("returns 429 once an address exceeds the limit for requests without a credential", async () => {
    app = await buildApp({
      rateLimiter: new RateLimiter(undefined, { burstCapacity: 1, ratePerSecond: 1 }),
    });

    const r1 = await app.inject({ method: "GET", url: "/.env", remoteAddress: "198.51.100.9" });
    expect(r1.statusCode).toBe(404);

    const r2 = await app.inject({
      method: "GET",
      url: "/.git/config",
      remoteAddress: "198.51.100.9",
    });
    expect(r2.statusCode).toBe(429);
    expect(r2.headers["retry-after"]).toBeDefined();
  });

  it("does not charge authenticated requests to the IP bucket", async () => {
    app = await buildApp({
      rateLimiter: new RateLimiter(undefined, { burstCapacity: 1, ratePerSecond: 1 }),
    });

    for (let i = 0; i < 5; i++) {
      expect((await authedEvents(app)).statusCode).toBe(200);
    }
  });

  it("scanner traffic from the same address never throttles an authenticated SDK", async () => {
    // Behind a proxy without TRUST_PROXY every client shares one address —
    // the situation #94 was filed for.
    app = await buildApp({
      rateLimiter: new RateLimiter(undefined, { burstCapacity: 20, ratePerSecond: 10 }),
    });

    const shared = "172.18.0.1";
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      statuses.push(
        (await app.inject({ method: "GET", url: `/scan-${i}`, remoteAddress: shared })).statusCode,
      );
    }
    expect(statuses).toContain(429); // the scanner itself is limited

    expect((await authedEvents(app, shared)).statusCode).toBe(200);
  });

  it("refuses credentialed requests from an address only after repeated auth failures", async () => {
    app = await buildApp({
      rateLimiter: new RateLimiter(undefined, { burstCapacity: 2, ratePerSecond: 1 }),
      resolve: async (token) =>
        token === TEST_KEY ? { projectId: TEST_PROJECT_ID, workspaceId: TEST_WORKSPACE_ID } : null,
    });
    const badKey = { authorization: "Bearer yav_00000000000000000000000000000000" };
    const send = (headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/v1/events",
        remoteAddress: "198.51.100.66",
        headers,
        payload: { events: [makeEvent()] },
      });

    expect((await send(badKey)).statusCode).toBe(401);
    expect((await send(badKey)).statusCode).toBe(401);
    // Budget of 2 failures used: further credentialed requests are refused
    // before the key is looked up, valid key or not.
    expect((await send(badKey)).statusCode).toBe(429);
    expect((await send({ authorization: `Bearer ${TEST_KEY}` })).statusCode).toBe(429);
    // A different address is unaffected.
    expect((await authedEvents(app, "198.51.100.67")).statusCode).toBe(200);
  });

  it("does not count a keyed client's malformed bodies as auth failures (#113)", async () => {
    // Header auth runs before body parsing on the events route, so a 400 from
    // the parser arrives authenticated. Before, it drained the auth-failure
    // bucket and the client's well-formed requests were refused with 429.
    app = await buildApp({
      rateLimiter: new RateLimiter(undefined, { burstCapacity: 2, ratePerSecond: 1 }),
      resolve: async (token) =>
        token === TEST_KEY ? { projectId: TEST_PROJECT_ID, workspaceId: TEST_WORKSPACE_ID } : null,
    });
    const address = "198.51.100.70";
    const malformed = (authorization: string) =>
      app.inject({
        method: "POST",
        url: "/v1/events",
        remoteAddress: address,
        headers: { authorization, "content-type": "application/json" },
        payload: "{not json",
      });

    for (let i = 0; i < 5; i++) {
      expect((await malformed(`Bearer ${TEST_KEY}`)).statusCode).toBe(400);
    }
    expect((await authedEvents(app, address)).statusCode).toBe(200);

    // A bad key is refused before the body is parsed: 401, not 400 — and it
    // still counts as a failure.
    expect((await malformed("Bearer yav_00000000000000000000000000000000")).statusCode).toBe(401);
    expect((await malformed("Bearer yav_00000000000000000000000000000000")).statusCode).toBe(401);
    expect((await malformed("Bearer yav_00000000000000000000000000000000")).statusCode).toBe(429);
  });

  it("charges a keyed client's unparseable bodies to its key's bucket (#113)", async () => {
    // Not to the address, but not to nothing either: the handler never runs
    // for them, so the plugin charges one unit on response.
    app = await buildApp({ rateLimiter: new RateLimiter({ burstCapacity: 3, ratePerSecond: 1 }) });
    const malformed = () =>
      app.inject({
        method: "POST",
        url: "/v1/events",
        remoteAddress: "198.51.100.71",
        headers: { authorization: `Bearer ${TEST_KEY}`, "content-type": "application/json" },
        payload: "{not json",
      });
    for (let i = 0; i < 3; i++) expect((await malformed()).statusCode).toBe(400);
    const refused = await authedEvents(app, "198.51.100.71");
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe("YAVIO-2050"); // the key's limit, not the IP's
  });

  it("does not rate limit health endpoint", async () => {
    app = await buildApp({
      rateLimiter: new RateLimiter(undefined, { burstCapacity: 0, ratePerSecond: 0 }),
    });

    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
  });

  it("returns 429 when API key rate limit is exceeded", async () => {
    app = await buildApp({ rateLimiter: new RateLimiter({ burstCapacity: 1, ratePerSecond: 1 }) });

    // First request passes (1 event fits in burst capacity of 1)
    expect((await authedEvents(app)).statusCode).toBe(200);
    // Second request should be rate limited by API key bucket
    expect((await authedEvents(app)).statusCode).toBe(429);
  });
});

describe("TRUST_PROXY (#94)", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  const unauthenticated = (remoteAddress: string, forwardedFor: string) =>
    app.inject({
      method: "GET",
      url: "/unknown",
      remoteAddress,
      headers: { "x-forwarded-for": forwardedFor },
    });

  it("keys requests from the trusted proxy on X-Forwarded-For", async () => {
    app = await buildApp({
      rateLimiter: new RateLimiter(undefined, { burstCapacity: 1, ratePerSecond: 1 }),
      trustProxy: ["172.30.240.1"],
    });

    expect((await unauthenticated("172.30.240.1", "203.0.113.5")).statusCode).toBe(404);
    expect((await unauthenticated("172.30.240.1", "203.0.113.6")).statusCode).toBe(404);
    // Same client again: its own bucket is used up.
    expect((await unauthenticated("172.30.240.1", "203.0.113.5")).statusCode).toBe(429);
  });

  it("ignores X-Forwarded-For from an address that is not trusted", async () => {
    app = await buildApp({
      rateLimiter: new RateLimiter(undefined, { burstCapacity: 1, ratePerSecond: 1 }),
      trustProxy: ["172.30.240.1"],
    });

    expect((await unauthenticated("198.51.100.20", "203.0.113.5")).statusCode).toBe(404);
    // A forged header does not buy a fresh bucket.
    expect((await unauthenticated("198.51.100.20", "203.0.113.99")).statusCode).toBe(429);
  });

  it("trusts nothing when unset", async () => {
    app = await buildApp({
      rateLimiter: new RateLimiter(undefined, { burstCapacity: 1, ratePerSecond: 1 }),
    });

    expect((await unauthenticated("172.30.240.1", "203.0.113.5")).statusCode).toBe(404);
    expect((await unauthenticated("172.30.240.1", "203.0.113.6")).statusCode).toBe(429);
  });
});
