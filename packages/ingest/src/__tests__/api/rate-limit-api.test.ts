import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../index.js";
import type { ApiKeyResolver } from "../../lib/api-key-resolver.js";
import { RateLimiter } from "../../lib/rate-limiter.js";

const TEST_KEY = "yav_abc123def456abc123def456abc123de";

function mockDb() {
  return { execute: async () => [{ "?column?": 1 }] } as unknown as Database;
}

function mockClickHouse() {
  return { ping: async () => ({ success: true }) } as unknown as ClickHouseClient;
}

function mockResolver() {
  return {
    resolve: async () => ({ projectId: "p1", workspaceId: "w1" }),
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

describe("Rate limiting — API integration", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("per-IP: returns 429 with Retry-After header", async () => {
    const rateLimiter = new RateLimiter(undefined, { burstCapacity: 1, ratePerSecond: 1 });
    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      apiKeyResolver: mockResolver(),
      jwtSecret: "s",
      rateLimiter,
      logger: false,
    });

    await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { events: [makeEvent()] },
    });

    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { events: [makeEvent()] },
    });
    expect(r.statusCode).toBe(429);
    expect(r.headers["retry-after"]).toBeDefined();
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("per-API-key: returns 429 when event count exceeds burst", async () => {
    const rateLimiter = new RateLimiter(
      { burstCapacity: 2, ratePerSecond: 1 },
      { burstCapacity: 1000, ratePerSecond: 1000 }, // high IP limit so it doesn't interfere
    );
    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      apiKeyResolver: mockResolver(),
      jwtSecret: "s",
      rateLimiter,
      logger: false,
    });

    // First request: 2 events, uses entire burst
    const r1 = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { events: [makeEvent(), makeEvent()] },
    });
    expect(r1.statusCode).toBe(200);

    // Second request: 1 event, exceeds available tokens
    const r2 = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { events: [makeEvent()] },
    });
    expect(r2.statusCode).toBe(429);
    expect(r2.json().error.code).toBe("YAVIO-2050");
  });

  it("health endpoint is not rate limited", async () => {
    const rateLimiter = new RateLimiter(
      { burstCapacity: 0, ratePerSecond: 0 },
      { burstCapacity: 0, ratePerSecond: 0 },
    );
    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      apiKeyResolver: mockResolver(),
      jwtSecret: "s",
      rateLimiter,
      logger: false,
    });

    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
  });

  it("no rate limiter configured means no limiting", async () => {
    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      apiKeyResolver: mockResolver(),
      jwtSecret: "s",
      logger: false,
    });

    // Multiple requests should all pass
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${TEST_KEY}` },
        payload: { events: [makeEvent()] },
      });
      expect(r.statusCode).toBe(200);
    }
  });
});
