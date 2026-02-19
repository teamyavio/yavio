import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../index.js";
import type { ApiKeyResolver } from "../lib/api-key-resolver.js";
import { jwtVerify } from "../lib/jwt.js";

const JWT_SECRET = "test-jwt-secret";
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

describe("POST /v1/widget-tokens", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  async function buildApp() {
    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      apiKeyResolver: mockApiKeyResolver(),
      jwtSecret: JWT_SECRET,
      logger: false,
    });
    return app;
  }

  it("mints a JWT for valid API key request", async () => {
    await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/widget-tokens",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { traceId: "trace-1", sessionId: "session-1" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.token).toBeDefined();
    expect(body.expiresAt).toBeDefined();

    // Verify the minted JWT
    const payload = jwtVerify(body.token, JWT_SECRET);
    expect(payload).not.toBeNull();
    expect(payload?.pid).toBe(TEST_PROJECT_ID);
    expect(payload?.wid).toBe(TEST_WORKSPACE_ID);
    expect(payload?.tid).toBe("trace-1");
    expect(payload?.sid).toBe("session-1");
  });

  it("returns 401 without auth header", async () => {
    await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/widget-tokens",
      payload: { traceId: "trace-1", sessionId: "session-1" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 400 when traceId is missing", async () => {
    await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/widget-tokens",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { sessionId: "session-1" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("YAVIO-2300");
  });

  it("returns 400 when sessionId is missing", async () => {
    await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/widget-tokens",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { traceId: "trace-1" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("YAVIO-2301");
  });

  it("expiresAt is approximately 15 minutes in the future", async () => {
    await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/widget-tokens",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { traceId: "trace-1", sessionId: "session-1" },
    });

    const body = response.json();
    const expiresAt = new Date(body.expiresAt).getTime();
    const now = Date.now();
    const diff = expiresAt - now;
    // Should be roughly 15 minutes (900s ± 5s tolerance)
    expect(diff).toBeGreaterThan(895_000);
    expect(diff).toBeLessThan(905_000);
  });
});
