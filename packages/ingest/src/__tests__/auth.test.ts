import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../index.js";
import type { ApiKeyResolver } from "../lib/api-key-resolver.js";
import { jwtSign } from "../lib/jwt.js";

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

function mockApiKeyResolver(result: { projectId: string; workspaceId: string } | null) {
  return {
    resolve: async () => result,
    clearCache: () => {},
  } as unknown as ApiKeyResolver;
}

describe("Auth plugin", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  async function buildApp(resolverResult: { projectId: string; workspaceId: string } | null) {
    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      apiKeyResolver: mockApiKeyResolver(resolverResult),
      jwtSecret: JWT_SECRET,
      logger: false,
    });

    const { authenticate } = await import("../plugins/auth.js");
    app.post("/test-auth", { preHandler: [authenticate] }, async (request) => {
      return { authContext: request.authContext };
    });

    return app;
  }

  it("returns 401 when Authorization header is missing", async () => {
    await buildApp(null);
    const response = await app.inject({ method: "POST", url: "/test-auth" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("YAVIO-2000");
  });

  it("returns 401 for malformed Authorization header", async () => {
    await buildApp(null);
    const response = await app.inject({
      method: "POST",
      url: "/test-auth",
      headers: { authorization: "Basic abc123" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("YAVIO-2006");
  });

  it("returns 401 for unrecognised token format", async () => {
    await buildApp(null);
    const response = await app.inject({
      method: "POST",
      url: "/test-auth",
      headers: { authorization: "Bearer random-token" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("YAVIO-2006");
  });

  it("returns 401 for invalid API key", async () => {
    await buildApp(null);
    const response = await app.inject({
      method: "POST",
      url: "/test-auth",
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("YAVIO-2001");
  });

  it("authenticates valid API key and decorates authContext", async () => {
    await buildApp({ projectId: TEST_PROJECT_ID, workspaceId: TEST_WORKSPACE_ID });
    const response = await app.inject({
      method: "POST",
      url: "/test-auth",
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().authContext).toEqual({
      projectId: TEST_PROJECT_ID,
      workspaceId: TEST_WORKSPACE_ID,
      source: "api_key",
    });
  });

  it("authenticates valid JWT and decorates authContext", async () => {
    await buildApp(null);
    const now = Math.floor(Date.now() / 1000);
    const token = jwtSign(
      {
        pid: TEST_PROJECT_ID,
        wid: TEST_WORKSPACE_ID,
        tid: "trace-1",
        sid: "session-1",
        iat: now,
        exp: now + 900,
      },
      JWT_SECRET,
    );

    const response = await app.inject({
      method: "POST",
      url: "/test-auth",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().authContext).toEqual({
      projectId: TEST_PROJECT_ID,
      workspaceId: TEST_WORKSPACE_ID,
      traceId: "trace-1",
      sessionId: "session-1",
      source: "jwt",
    });
  });

  it("returns 401 for expired JWT", async () => {
    await buildApp(null);
    const now = Math.floor(Date.now() / 1000);
    const token = jwtSign(
      {
        pid: TEST_PROJECT_ID,
        wid: TEST_WORKSPACE_ID,
        tid: "trace-1",
        sid: "session-1",
        iat: now - 1000,
        exp: now - 1,
      },
      JWT_SECRET,
    );

    const response = await app.inject({
      method: "POST",
      url: "/test-auth",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("YAVIO-2004");
  });

  it("returns 401 for JWT signed with wrong secret", async () => {
    await buildApp(null);
    const now = Math.floor(Date.now() / 1000);
    const token = jwtSign(
      {
        pid: TEST_PROJECT_ID,
        wid: TEST_WORKSPACE_ID,
        tid: "trace-1",
        sid: "session-1",
        iat: now,
        exp: now + 900,
      },
      "wrong-secret",
    );

    const response = await app.inject({
      method: "POST",
      url: "/test-auth",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("YAVIO-2004");
  });

  it("health endpoint remains unauthenticated", async () => {
    await buildApp(null);
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
  });
});
