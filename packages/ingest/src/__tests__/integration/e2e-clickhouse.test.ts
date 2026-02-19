import { randomUUID } from "node:crypto";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../index.js";
import type { ApiKeyResolver } from "../../lib/api-key-resolver.js";
import { BatchWriter } from "../../lib/batch-writer.js";
import { jwtSign } from "../../lib/jwt.js";
import {
  disconnect,
  getClient,
  runMigrations,
  truncateEvents,
} from "./helpers/clickhouse-setup.js";

const JWT_SECRET = "e2e-jwt-secret";
const TEST_KEY = "yav_e2e_test_key_00000000000000000";
const TEST_PROJECT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TEST_WORKSPACE_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

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
    trace_id: "trace-e2e",
    session_id: "session-e2e",
    timestamp: new Date().toISOString(),
    source: "server",
    ...overrides,
  };
}

async function queryEvents(where = "1=1") {
  const ch = getClient();
  const result = await ch.query({
    query: `SELECT * FROM events WHERE ${where}`,
    format: "JSONEachRow",
  });
  return result.json<Record<string, unknown>>();
}

describe("E2E: Ingest API → ClickHouse", () => {
  let app: FastifyInstance;
  let batchWriter: BatchWriter;

  beforeAll(async () => {
    await runMigrations();
    await truncateEvents();
  });

  afterAll(async () => {
    await disconnect();
  });

  afterEach(async () => {
    await app?.close();
  });

  async function buildApp() {
    const clickhouse = getClient();
    batchWriter = new BatchWriter({
      clickhouse,
      flushSize: 100,
      flushIntervalMs: 60_000, // manual flush in tests
    });

    app = await createApp({
      db: mockDb(),
      clickhouse,
      apiKeyResolver: mockResolver(),
      jwtSecret: JWT_SECRET,
      batchWriter,
      logger: false,
    });
    return app;
  }

  it("tool_call event with all fields lands in ClickHouse", async () => {
    await buildApp();
    const eventId = randomUUID();

    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: {
        events: [
          makeEvent({
            event_id: eventId,
            event_type: "tool_call",
            event_name: "search_products",
            latency_ms: 142.5,
            status: "success",
            input_keys: { query: true, limit: true },
            input_types: { query: "string", limit: "number" },
            intent_signals: { intent: "search" },
            tokens_in: 120,
            tokens_out: 450,
            country_code: "DE",
            platform: "node",
            sdk_version: "1.2.3",
          }),
        ],
      },
    });

    expect(r.statusCode).toBe(200);
    await batchWriter.flush();

    const rows = await queryEvents(`event_id = '${eventId}'`);
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.event_type).toBe("tool_call");
    expect(row.event_name).toBe("search_products");
    expect(row.workspace_id).toBe(TEST_WORKSPACE_ID);
    expect(row.project_id).toBe(TEST_PROJECT_ID);
    expect(row.trace_id).toBe("trace-e2e");
    expect(row.session_id).toBe("session-e2e");
    expect(row.source).toBe("server");
    expect(row.latency_ms).toBe(142.5);
    expect(row.status).toBe("success");
    expect(row.tokens_in).toBe(120);
    expect(row.tokens_out).toBe(450);
    expect(row.country_code).toBe("DE");
    expect(row.platform).toBe("node");
    expect(row.sdk_version).toBe("1.2.3");

    // JSON fields are stored as strings in ClickHouse
    const inputKeys = JSON.parse(row.input_keys as string);
    expect(inputKeys).toEqual({ query: true, limit: true });
    const inputTypes = JSON.parse(row.input_types as string);
    expect(inputTypes).toEqual({ query: "string", limit: "number" });
    const intentSignals = JSON.parse(row.intent_signals as string);
    expect(intentSignals).toEqual({ intent: "search" });

    // Enrichment
    expect(row.ingested_at).toBeDefined();

    await batchWriter.shutdown();
  });

  it("identify event preserves user_id and PII-strips user_traits", async () => {
    await buildApp();
    const eventId = randomUUID();

    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: {
        events: [
          makeEvent({
            event_id: eventId,
            event_type: "identify",
            user_id: "usr-42",
            user_traits: { name: "Alice", email: "alice@example.com", plan: "pro" },
          }),
        ],
      },
    });

    expect(r.statusCode).toBe(200);
    await batchWriter.flush();

    const rows = await queryEvents(`event_id = '${eventId}'`);
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.event_type).toBe("identify");
    expect(row.user_id).toBe("usr-42");

    const traits = JSON.parse(row.user_traits as string);
    expect(traits.email).toBe("[EMAIL_REDACTED]");
    expect(traits.plan).toBe("pro");

    await batchWriter.shutdown();
  });

  it("conversion event preserves value and currency", async () => {
    await buildApp();
    const eventId = randomUUID();

    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: {
        events: [
          makeEvent({
            event_id: eventId,
            event_type: "conversion",
            event_name: "purchase",
            conversion_value: 49.99,
            conversion_currency: "EUR",
          }),
        ],
      },
    });

    expect(r.statusCode).toBe(200);
    await batchWriter.flush();

    const rows = await queryEvents(`event_id = '${eventId}'`);
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.event_type).toBe("conversion");
    expect(row.event_name).toBe("purchase");
    expect(row.conversion_value).toBe(49.99);
    expect(row.conversion_currency).toBe("EUR");

    await batchWriter.shutdown();
  });

  it("widget_render event via JWT preserves widget fields", async () => {
    await buildApp();
    const eventId = randomUUID();
    const traceId = `trace-widget-${randomUUID().slice(0, 8)}`;

    const now = Math.floor(Date.now() / 1000);
    const token = jwtSign(
      {
        pid: TEST_PROJECT_ID,
        wid: TEST_WORKSPACE_ID,
        tid: traceId,
        sid: "ses-widget",
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
            event_id: eventId,
            event_type: "widget_render",
            trace_id: traceId,
            session_id: "ses-widget",
            source: "widget",
            viewport_width: 1920,
            viewport_height: 1080,
            device_pixel_ratio: 2.0,
            device_touch: 1,
            connection_type: "wifi",
          }),
        ],
      },
    });

    expect(r.statusCode).toBe(200);
    await batchWriter.flush();

    const rows = await queryEvents(`event_id = '${eventId}'`);
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.event_type).toBe("widget_render");
    expect(row.source).toBe("widget");
    expect(row.viewport_width).toBe(1920);
    expect(row.viewport_height).toBe(1080);
    expect(row.device_pixel_ratio).toBeCloseTo(2.0, 1);
    expect(row.device_touch).toBe(1);
    expect(row.connection_type).toBe("wifi");

    await batchWriter.shutdown();
  });

  it("multi-event batch writes all events to ClickHouse", async () => {
    await buildApp();
    const ids = [randomUUID(), randomUUID(), randomUUID()];

    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: {
        events: [
          makeEvent({ event_id: ids[0], event_type: "track", event_name: "page_view" }),
          makeEvent({ event_id: ids[1], event_type: "step", step_sequence: 1 }),
          makeEvent({
            event_id: ids[2],
            event_type: "connection",
            protocol_version: "2024-11-05",
            client_name: "claude",
            client_version: "1.0",
            connection_duration_ms: 5432.1,
          }),
        ],
      },
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().accepted).toBe(3);
    await batchWriter.flush();

    // Verify each event
    const trackRows = await queryEvents(`event_id = '${ids[0]}'`);
    expect(trackRows).toHaveLength(1);
    expect(trackRows[0].event_name).toBe("page_view");

    const stepRows = await queryEvents(`event_id = '${ids[1]}'`);
    expect(stepRows).toHaveLength(1);
    expect(stepRows[0].step_sequence).toBe(1);

    const connRows = await queryEvents(`event_id = '${ids[2]}'`);
    expect(connRows).toHaveLength(1);
    expect(connRows[0].protocol_version).toBe("2024-11-05");
    expect(connRows[0].client_name).toBe("claude");
    expect(connRows[0].client_version).toBe("1.0");
    expect(connRows[0].connection_duration_ms).toBeCloseTo(5432.1, 0);

    await batchWriter.shutdown();
  });
});
