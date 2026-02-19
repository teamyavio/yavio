import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../index.js";
import type { ApiKeyResolver } from "../lib/api-key-resolver.js";

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

describe("POST /v1/events", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  async function buildApp() {
    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      apiKeyResolver: mockApiKeyResolver(),
      jwtSecret: "test-secret",
      logger: false,
    });
    return app;
  }

  it("accepts a valid batch and returns 200", async () => {
    await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { events: [makeEvent()] },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(0);
  });

  it("returns 401 without auth", async () => {
    await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: { events: [makeEvent()] },
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 400 for all-invalid batch", async () => {
    await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { events: [{ bad: "event" }] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().accepted).toBe(0);
  });

  it("returns 207 for partial batch", async () => {
    await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { events: [makeEvent(), { bad: "event" }] },
    });
    expect(response.statusCode).toBe(207);
    const body = response.json();
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(1);
  });

  it("returns 400 for empty events array", async () => {
    await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { events: [] },
    });
    expect(response.statusCode).toBe(400);
  });

  it("strips PII from events", async () => {
    await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: {
        events: [makeEvent({ metadata: { email: "user@example.com" } })],
      },
    });
    expect(response.statusCode).toBe(200);
  });

  it("rejects events with field limits violations", async () => {
    await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: {
        events: [makeEvent({ event_name: "x".repeat(300) })],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("handles batch with truncation warnings", async () => {
    await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: {
        events: [makeEvent({ metadata: { data: "x".repeat(11_000) } })],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.accepted).toBe(1);
    expect(body.warnings).toBeDefined();
  });
});
