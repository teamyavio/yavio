import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../index.js";
import type { ApiKeyResolver } from "../lib/api-key-resolver.js";
import type { BatchWriter } from "../lib/batch-writer.js";

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

function mockBatchWriter() {
  return {
    enqueue: () => false,
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

describe("Stress tests — large batches", () => {
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
      batchWriter: bw ?? mockBatchWriter(),
      logger: false,
    });
    return app;
  }

  it("accepts a 1000-event batch and returns 200", async () => {
    await buildApp();
    const events = Array.from({ length: 1000 }, () => makeEvent());

    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: auth,
      payload: { events },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.accepted).toBe(1000);
    expect(body.rejected).toBe(0);
  });

  it("returns 413 when batch exceeds 500KB", async () => {
    await buildApp();
    // Each event with large metadata to push batch over 500KB
    const events = Array.from({ length: 10 }, () =>
      makeEvent({ metadata: { data: "x".repeat(60_000) } }),
    );

    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: auth,
      payload: { events },
    });

    expect(r.statusCode).toBe(413);
  });

  it("batch just under 500KB succeeds", async () => {
    await buildApp();
    // ~100 events with ~4KB metadata each ≈ ~450KB total (under 500KB)
    const events = Array.from({ length: 100 }, () =>
      makeEvent({ metadata: { data: "y".repeat(4_000) } }),
    );

    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: auth,
      payload: { events },
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().accepted).toBe(100);
  });

  it("mixed large batch: 50 valid + 50 invalid returns 207 with correct counts", async () => {
    await buildApp();
    const validEvents = Array.from({ length: 50 }, () => makeEvent());
    const invalidEvents = Array.from({ length: 50 }, () => ({
      bad: randomUUID(),
    }));

    // Interleave valid and invalid
    const events = validEvents.flatMap((v, i) => [v, invalidEvents[i]]);

    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: auth,
      payload: { events },
    });

    expect(r.statusCode).toBe(207);
    const body = r.json();
    expect(body.accepted).toBe(50);
    expect(body.rejected).toBe(50);
    expect(body.errors).toHaveLength(50);
  });
});
