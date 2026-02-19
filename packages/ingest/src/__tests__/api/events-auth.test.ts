import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../index.js";
import type { ApiKeyResolver } from "../../lib/api-key-resolver.js";
import { jwtSign } from "../../lib/jwt.js";

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

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: randomUUID(),
    event_type: "track",
    trace_id: "trace-1",
    session_id: "session-1",
    timestamp: new Date().toISOString(),
    source: "server",
    ...overrides,
  };
}

function mockResolver(result: { projectId: string; workspaceId: string } | null) {
  return {
    resolve: async () => result,
    clearCache: () => {},
  } as unknown as ApiKeyResolver;
}

describe("POST /v1/events — auth scenarios", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("returns 401 when no Authorization header", async () => {
    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      apiKeyResolver: mockResolver(null),
      jwtSecret: JWT_SECRET,
      logger: false,
    });
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: { events: [makeEvent()] },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("YAVIO-2000");
  });

  it("returns 401 for malformed Authorization header (no Bearer prefix)", async () => {
    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      apiKeyResolver: mockResolver(null),
      jwtSecret: JWT_SECRET,
      logger: false,
    });
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: "Token abc" },
      payload: { events: [makeEvent()] },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("YAVIO-2006");
  });

  it("returns 401 for invalid API key", async () => {
    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      apiKeyResolver: mockResolver(null),
      jwtSecret: JWT_SECRET,
      logger: false,
    });
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { events: [makeEvent()] },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("YAVIO-2001");
  });

  it("authenticates with valid API key", async () => {
    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      apiKeyResolver: mockResolver({ projectId: TEST_PROJECT_ID, workspaceId: TEST_WORKSPACE_ID }),
      jwtSecret: JWT_SECRET,
      logger: false,
    });
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { events: [makeEvent()] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().accepted).toBe(1);
  });

  it("authenticates with valid JWT", async () => {
    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      apiKeyResolver: mockResolver(null),
      jwtSecret: JWT_SECRET,
      logger: false,
    });
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
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token}` },
      payload: { events: [makeEvent()] },
    });
    expect(r.statusCode).toBe(200);
  });

  it("returns 401 for expired JWT", async () => {
    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      apiKeyResolver: mockResolver(null),
      jwtSecret: JWT_SECRET,
      logger: false,
    });
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
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token}` },
      payload: { events: [makeEvent()] },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("YAVIO-2004");
  });

  it("returns 400 for JWT with trace_id mismatch", async () => {
    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      apiKeyResolver: mockResolver(null),
      jwtSecret: JWT_SECRET,
      logger: false,
    });
    const now = Math.floor(Date.now() / 1000);
    const token = jwtSign(
      {
        pid: TEST_PROJECT_ID,
        wid: TEST_WORKSPACE_ID,
        tid: "different-trace",
        sid: "session-1",
        iat: now,
        exp: now + 900,
      },
      JWT_SECRET,
    );
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token}` },
      payload: { events: [makeEvent({ trace_id: "trace-1" })] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("YAVIO-2112");
  });
});
