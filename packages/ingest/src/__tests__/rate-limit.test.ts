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

describe("Rate limit plugin", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("returns 429 when IP rate limit is exceeded", async () => {
    const rateLimiter = new RateLimiter(undefined, { burstCapacity: 1, ratePerSecond: 1 });
    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      apiKeyResolver: mockApiKeyResolver(),
      jwtSecret: "test-secret",
      rateLimiter,
      logger: false,
    });

    // First request should pass
    const r1 = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { events: [makeEvent()] },
    });
    expect(r1.statusCode).toBe(200);

    // Second request should be rate limited
    const r2 = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { events: [makeEvent()] },
    });
    expect(r2.statusCode).toBe(429);
    expect(r2.headers["retry-after"]).toBeDefined();
  });

  it("does not rate limit health endpoint", async () => {
    const rateLimiter = new RateLimiter(undefined, { burstCapacity: 0, ratePerSecond: 0 });
    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      apiKeyResolver: mockApiKeyResolver(),
      jwtSecret: "test-secret",
      rateLimiter,
      logger: false,
    });

    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
  });

  it("returns 429 when API key rate limit is exceeded", async () => {
    const rateLimiter = new RateLimiter({ burstCapacity: 1, ratePerSecond: 1 });
    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      apiKeyResolver: mockApiKeyResolver(),
      jwtSecret: "test-secret",
      rateLimiter,
      logger: false,
    });

    // First request passes (1 event fits in burst capacity of 1)
    const r1 = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { events: [makeEvent()] },
    });
    expect(r1.statusCode).toBe(200);

    // Second request should be rate limited by API key bucket
    const r2 = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { events: [makeEvent()] },
    });
    expect(r2.statusCode).toBe(429);
  });
});
