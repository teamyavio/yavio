import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../index.js";
import type { ApiKeyResolver } from "../../lib/api-key-resolver.js";
import { jwtSign, jwtVerify } from "../../lib/jwt.js";

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

function mockResolver(result: { projectId: string; workspaceId: string } | null) {
  return {
    resolve: async () => result,
    clearCache: () => {},
  } as unknown as ApiKeyResolver;
}

describe("POST /v1/widget-tokens — full API scenarios", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  async function buildApp(
    resolverResult = { projectId: TEST_PROJECT_ID, workspaceId: TEST_WORKSPACE_ID },
  ) {
    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      apiKeyResolver: mockResolver(resolverResult),
      jwtSecret: JWT_SECRET,
      logger: false,
    });
    return app;
  }

  it("mints a valid JWT for authenticated API key request", async () => {
    await buildApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/widget-tokens",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { traceId: "trace-123", sessionId: "ses-456" },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.token).toBeDefined();
    expect(body.expiresAt).toBeDefined();

    const payload = jwtVerify(body.token, JWT_SECRET);
    expect(payload).not.toBeNull();
    expect(payload?.pid).toBe(TEST_PROJECT_ID);
    expect(payload?.wid).toBe(TEST_WORKSPACE_ID);
    expect(payload?.tid).toBe("trace-123");
    expect(payload?.sid).toBe("ses-456");
  });

  it("returns 401 without auth", async () => {
    await buildApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/widget-tokens",
      payload: { traceId: "t", sessionId: "s" },
    });
    expect(r.statusCode).toBe(401);
  });

  it("returns 401 when using JWT auth (must use API key)", async () => {
    await buildApp();
    const now = Math.floor(Date.now() / 1000);
    const jwt = jwtSign(
      {
        pid: TEST_PROJECT_ID,
        wid: TEST_WORKSPACE_ID,
        tid: "t",
        sid: "s",
        iat: now,
        exp: now + 900,
      },
      JWT_SECRET,
    );
    const r = await app.inject({
      method: "POST",
      url: "/v1/widget-tokens",
      headers: { authorization: `Bearer ${jwt}` },
      payload: { traceId: "t", sessionId: "s" },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("YAVIO-2302");
  });

  it("returns 400 when traceId is missing", async () => {
    await buildApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/widget-tokens",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { sessionId: "s" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("YAVIO-2300");
  });

  it("returns 400 when sessionId is missing", async () => {
    await buildApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/widget-tokens",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { traceId: "t" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("YAVIO-2301");
  });

  it("minted token can be used to authenticate events endpoint", async () => {
    await buildApp();

    // Mint token
    const mintResponse = await app.inject({
      method: "POST",
      url: "/v1/widget-tokens",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { traceId: "trace-abc", sessionId: "ses-xyz" },
    });
    const { token } = mintResponse.json();

    // Use token to submit events
    const eventsResponse = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        events: [
          {
            event_id: "00000000-0000-0000-0000-000000000001",
            event_type: "widget_click",
            trace_id: "trace-abc",
            session_id: "ses-xyz",
            timestamp: new Date().toISOString(),
            source: "widget",
          },
        ],
      },
    });
    expect(eventsResponse.statusCode).toBe(200);
    expect(eventsResponse.json().accepted).toBe(1);
  });
});
