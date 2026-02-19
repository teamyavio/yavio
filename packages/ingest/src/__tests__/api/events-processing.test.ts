import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../index.js";
import type { ApiKeyResolver } from "../../lib/api-key-resolver.js";
import type { BatchWriter } from "../../lib/batch-writer.js";

const TEST_KEY = "yav_abc123def456abc123def456abc123de";
const TEST_PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const TEST_WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";

function mockDb() {
  return { execute: async () => [{ "?column?": 1 }] } as unknown as Database;
}

function mockClickHouse() {
  return { ping: async () => ({ success: true }) } as unknown as ClickHouseClient;
}

function mockResolver() {
  return {
    resolve: async () => ({ projectId: TEST_PROJECT_ID, workspaceId: TEST_WORKSPACE_ID }),
    clearCache: () => {},
  } as unknown as ApiKeyResolver;
}

function mockBatchWriter(overrides: Partial<BatchWriter> = {}) {
  return {
    enqueue: () => false,
    ...overrides,
  } as unknown as BatchWriter;
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

describe("POST /v1/events — processing scenarios", () => {
  let app: FastifyInstance;
  const auth = { authorization: `Bearer ${TEST_KEY}` };

  afterEach(async () => {
    await app?.close();
  });

  async function buildApp(bw?: BatchWriter) {
    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      apiKeyResolver: mockResolver(),
      jwtSecret: "test-secret",
      batchWriter: bw,
      logger: false,
    });
    return app;
  }

  it("returns 200 for valid single-event batch", async () => {
    await buildApp(mockBatchWriter());
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: auth,
      payload: { events: [makeEvent()] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ accepted: 1, rejected: 0 });
  });

  it("returns 200 for valid multi-event batch", async () => {
    await buildApp(mockBatchWriter());
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: auth,
      payload: { events: [makeEvent(), makeEvent(), makeEvent()] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().accepted).toBe(3);
  });

  it("returns 207 for partial batch (mixed valid/invalid)", async () => {
    await buildApp(mockBatchWriter());
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: auth,
      payload: { events: [makeEvent(), { invalid: true }, makeEvent()] },
    });
    expect(r.statusCode).toBe(207);
    const body = r.json();
    expect(body.accepted).toBe(2);
    expect(body.rejected).toBe(1);
    expect(body.errors).toHaveLength(1);
  });

  it("returns 400 for all-invalid batch", async () => {
    await buildApp(mockBatchWriter());
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: auth,
      payload: { events: [{ bad: true }, { also_bad: true }] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().accepted).toBe(0);
  });

  it("returns 400 for empty events array", async () => {
    await buildApp(mockBatchWriter());
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: auth,
      payload: { events: [] },
    });
    expect(r.statusCode).toBe(400);
  });

  it("returns 400 for missing events field", async () => {
    await buildApp(mockBatchWriter());
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: auth,
      payload: { data: [] },
    });
    expect(r.statusCode).toBe(400);
  });

  it("returns 200 with warnings for truncated metadata", async () => {
    await buildApp(mockBatchWriter());
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: auth,
      payload: { events: [makeEvent({ metadata: { big: "x".repeat(11_000) } })] },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.accepted).toBe(1);
    expect(body.warnings).toBeDefined();
    expect(body.warnings[0].field).toBe("metadata");
  });

  it("returns 503 with Retry-After when backpressure is active", async () => {
    const bw = mockBatchWriter({ enqueue: () => true });
    await buildApp(bw);
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: auth,
      payload: { events: [makeEvent()] },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe("YAVIO-2402");
    expect(r.headers["retry-after"]).toBeDefined();
  });

  it("strips PII from event metadata", async () => {
    const enqueuedEvents: unknown[] = [];
    const bw = mockBatchWriter({
      enqueue: (events: unknown[]) => {
        enqueuedEvents.push(...events);
        return false;
      },
    });
    await buildApp(bw);

    await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: auth,
      payload: { events: [makeEvent({ metadata: { email: "user@example.com" } })] },
    });

    const event = enqueuedEvents[0] as Record<string, unknown>;
    const metadata = JSON.parse(event.metadata as string);
    expect(metadata.email).toBe("[EMAIL_REDACTED]");
  });

  it("enriches events with workspace and project IDs", async () => {
    const enqueuedEvents: unknown[] = [];
    const bw = mockBatchWriter({
      enqueue: (events: unknown[]) => {
        enqueuedEvents.push(...events);
        return false;
      },
    });
    await buildApp(bw);

    await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: auth,
      payload: { events: [makeEvent()] },
    });

    const event = enqueuedEvents[0] as Record<string, string>;
    expect(event.workspace_id).toBe(TEST_WORKSPACE_ID);
    expect(event.project_id).toBe(TEST_PROJECT_ID);
    expect(event.ingested_at).toBeDefined();
  });
});
