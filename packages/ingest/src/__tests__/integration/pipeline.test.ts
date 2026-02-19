import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../index.js";
import type { ApiKeyResolver } from "../../lib/api-key-resolver.js";
import { BatchWriter } from "../../lib/batch-writer.js";
import { jwtSign } from "../../lib/jwt.js";

const JWT_SECRET = "test-jwt-secret";
const TEST_KEY = "yav_abc123def456abc123def456abc123de";
const TEST_PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const TEST_WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";

function mockDb() {
  return { execute: async () => [{ "?column?": 1 }] } as unknown as Database;
}

function mockResolver() {
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

describe("Full pipeline integration", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("events flow through auth → validation → limits → PII → enrich → batch writer", async () => {
    const insertedBatches: unknown[][] = [];
    const mockCh = {
      ping: async () => ({ success: true }),
      insert: vi.fn().mockImplementation(async ({ values }: { values: unknown[] }) => {
        insertedBatches.push(values);
      }),
    } as unknown as ClickHouseClient;

    const batchWriter = new BatchWriter({
      clickhouse: mockCh,
      flushSize: 100,
      flushIntervalMs: 60_000,
    });

    app = await createApp({
      db: mockDb(),
      clickhouse: mockCh,
      apiKeyResolver: mockResolver(),
      jwtSecret: JWT_SECRET,
      batchWriter,
      logger: false,
    });

    // Submit events with PII in metadata
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: {
        events: [
          makeEvent({
            event_name: "signup",
            metadata: { user_email: "john@example.com", plan: "pro" },
          }),
          makeEvent({
            event_type: "conversion",
            metadata: { value: 99.99 },
          }),
        ],
      },
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().accepted).toBe(2);

    // Flush the batch writer to write to ClickHouse
    await batchWriter.flush();

    // Verify events were written
    expect(insertedBatches).toHaveLength(1);
    const written = insertedBatches[0] as Record<string, unknown>[];
    expect(written).toHaveLength(2);

    // Check enrichment
    expect(written[0].workspace_id).toBe(TEST_WORKSPACE_ID);
    expect(written[0].project_id).toBe(TEST_PROJECT_ID);
    expect(written[0].ingested_at).toBeDefined();

    // Check PII was stripped from metadata (stringified for ClickHouse)
    const meta = JSON.parse(written[0].metadata as string);
    expect(meta.user_email).toBe("[EMAIL_REDACTED]");
    expect(meta.plan).toBe("pro"); // non-PII preserved

    await batchWriter.shutdown();
  });

  it("widget JWT flow: mint → submit events → verify trace_id binding", async () => {
    const insertedBatches: unknown[][] = [];
    const mockCh = {
      ping: async () => ({ success: true }),
      insert: vi.fn().mockImplementation(async ({ values }: { values: unknown[] }) => {
        insertedBatches.push(values);
      }),
    } as unknown as ClickHouseClient;

    const batchWriter = new BatchWriter({
      clickhouse: mockCh,
      flushSize: 100,
      flushIntervalMs: 60_000,
    });

    app = await createApp({
      db: mockDb(),
      clickhouse: mockCh,
      apiKeyResolver: mockResolver(),
      jwtSecret: JWT_SECRET,
      batchWriter,
      logger: false,
    });

    // 1. Mint widget token
    const mintR = await app.inject({
      method: "POST",
      url: "/v1/widget-tokens",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { traceId: "widget-trace-1", sessionId: "widget-ses-1" },
    });
    expect(mintR.statusCode).toBe(200);
    const { token } = mintR.json();

    // 2. Submit widget events with matching trace_id
    const eventsR = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        events: [
          makeEvent({
            event_type: "widget_click",
            trace_id: "widget-trace-1",
            session_id: "widget-ses-1",
            source: "widget",
          }),
        ],
      },
    });
    expect(eventsR.statusCode).toBe(200);
    expect(eventsR.json().accepted).toBe(1);

    // 3. Flush and verify
    await batchWriter.flush();
    expect(insertedBatches).toHaveLength(1);
    const written = insertedBatches[0] as Record<string, string>[];
    expect(written[0].trace_id).toBe("widget-trace-1");
    expect(written[0].workspace_id).toBe(TEST_WORKSPACE_ID);

    await batchWriter.shutdown();
  });

  it("widget JWT rejects events with mismatched trace_id", async () => {
    const mockCh = {
      ping: async () => ({ success: true }),
    } as unknown as ClickHouseClient;

    app = await createApp({
      db: mockDb(),
      clickhouse: mockCh,
      apiKeyResolver: mockResolver(),
      jwtSecret: JWT_SECRET,
      logger: false,
    });

    const now = Math.floor(Date.now() / 1000);
    const token = jwtSign(
      {
        pid: TEST_PROJECT_ID,
        wid: TEST_WORKSPACE_ID,
        tid: "bound-trace",
        sid: "ses-1",
        iat: now,
        exp: now + 900,
      },
      JWT_SECRET,
    );

    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        events: [makeEvent({ trace_id: "different-trace" })],
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("YAVIO-2112");
  });

  it("tool_call fields survive full pipeline to batch writer", async () => {
    const insertedBatches: unknown[][] = [];
    const mockCh = {
      ping: async () => ({ success: true }),
      insert: vi.fn().mockImplementation(async ({ values }: { values: unknown[] }) => {
        insertedBatches.push(values);
      }),
    } as unknown as ClickHouseClient;

    const batchWriter = new BatchWriter({
      clickhouse: mockCh,
      flushSize: 100,
      flushIntervalMs: 60_000,
    });

    app = await createApp({
      db: mockDb(),
      clickhouse: mockCh,
      apiKeyResolver: mockResolver(),
      jwtSecret: JWT_SECRET,
      batchWriter,
      logger: false,
    });

    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: {
        events: [
          makeEvent({
            event_type: "tool_call",
            event_name: "search",
            latency_ms: 150,
            status: "success",
            input_keys: { query: true },
            input_types: { query: "string" },
            intent_signals: { intent: "search" },
            tokens_in: 50,
            tokens_out: 200,
            country_code: "DE",
          }),
        ],
      },
    });

    expect(r.statusCode).toBe(200);
    await batchWriter.flush();

    expect(insertedBatches).toHaveLength(1);
    const written = insertedBatches[0][0] as Record<string, unknown>;
    expect(written.event_type).toBe("tool_call");
    expect(written.latency_ms).toBe(150);
    expect(written.status).toBe("success");
    expect(JSON.parse(written.input_keys as string)).toEqual({ query: true });
    expect(JSON.parse(written.input_types as string)).toEqual({ query: "string" });
    expect(JSON.parse(written.intent_signals as string)).toEqual({ intent: "search" });
    expect(written.tokens_in).toBe(50);
    expect(written.tokens_out).toBe(200);
    expect(written.country_code).toBe("DE");
    // Enrichment fields also present
    expect(written.workspace_id).toBe(TEST_WORKSPACE_ID);
    expect(written.project_id).toBe(TEST_PROJECT_ID);

    await batchWriter.shutdown();
  });

  it("identify user_traits survive pipeline and get PII-stripped", async () => {
    const insertedBatches: unknown[][] = [];
    const mockCh = {
      ping: async () => ({ success: true }),
      insert: vi.fn().mockImplementation(async ({ values }: { values: unknown[] }) => {
        insertedBatches.push(values);
      }),
    } as unknown as ClickHouseClient;

    const batchWriter = new BatchWriter({
      clickhouse: mockCh,
      flushSize: 100,
      flushIntervalMs: 60_000,
    });

    app = await createApp({
      db: mockDb(),
      clickhouse: mockCh,
      apiKeyResolver: mockResolver(),
      jwtSecret: JWT_SECRET,
      batchWriter,
      logger: false,
    });

    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: {
        events: [
          makeEvent({
            event_type: "identify",
            user_id: "usr-42",
            user_traits: { name: "Alice", email: "alice@example.com", plan: "pro" },
          }),
        ],
      },
    });

    expect(r.statusCode).toBe(200);
    await batchWriter.flush();

    const written = insertedBatches[0][0] as Record<string, unknown>;
    expect(written.user_id).toBe("usr-42");
    const traits = JSON.parse(written.user_traits as string);
    expect(traits.email).toBe("[EMAIL_REDACTED]");
    expect(traits.plan).toBe("pro");

    await batchWriter.shutdown();
  });

  it("widget_render fields survive pipeline", async () => {
    const insertedBatches: unknown[][] = [];
    const mockCh = {
      ping: async () => ({ success: true }),
      insert: vi.fn().mockImplementation(async ({ values }: { values: unknown[] }) => {
        insertedBatches.push(values);
      }),
    } as unknown as ClickHouseClient;

    const batchWriter = new BatchWriter({
      clickhouse: mockCh,
      flushSize: 100,
      flushIntervalMs: 60_000,
    });

    app = await createApp({
      db: mockDb(),
      clickhouse: mockCh,
      apiKeyResolver: mockResolver(),
      jwtSecret: JWT_SECRET,
      batchWriter,
      logger: false,
    });

    const now = Math.floor(Date.now() / 1000);
    const token = jwtSign(
      {
        pid: TEST_PROJECT_ID,
        wid: TEST_WORKSPACE_ID,
        tid: "widget-trace-2",
        sid: "widget-ses-2",
        iat: now,
        exp: now + 900,
      },
      JWT_SECRET,
    );

    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        events: [
          makeEvent({
            event_type: "widget_render",
            trace_id: "widget-trace-2",
            session_id: "widget-ses-2",
            source: "widget",
            viewport_width: 1024,
            viewport_height: 768,
            device_pixel_ratio: 2.0,
            device_touch: 0,
            connection_type: "4g",
          }),
        ],
      },
    });

    expect(r.statusCode).toBe(200);
    await batchWriter.flush();

    const written = insertedBatches[0][0] as Record<string, unknown>;
    expect(written.viewport_width).toBe(1024);
    expect(written.viewport_height).toBe(768);
    expect(written.device_pixel_ratio).toBe(2.0);
    expect(written.device_touch).toBe(0);
    expect(written.connection_type).toBe("4g");

    await batchWriter.shutdown();
  });

  it("mixed batch: valid + invalid + oversized fields", async () => {
    const mockCh = {
      ping: async () => ({ success: true }),
    } as unknown as ClickHouseClient;

    app = await createApp({
      db: mockDb(),
      clickhouse: mockCh,
      apiKeyResolver: mockResolver(),
      jwtSecret: JWT_SECRET,
      logger: false,
    });

    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: {
        events: [
          makeEvent(), // valid
          { invalid: true }, // schema invalid
          makeEvent({ event_name: "x".repeat(300) }), // field limit violation
          makeEvent({ metadata: { big: "y".repeat(11_000) } }), // truncated, still accepted
        ],
      },
    });
    expect(r.statusCode).toBe(207);
    const body = r.json();
    // 1 valid + 1 truncated = 2 accepted
    // 1 schema invalid + 1 field-rejected = 2 rejected
    expect(body.accepted).toBe(2);
    expect(body.rejected).toBe(2);
    expect(body.errors).toBeDefined();
    expect(body.warnings).toBeDefined();
  });
});
