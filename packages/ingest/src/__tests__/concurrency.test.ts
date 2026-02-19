import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../index.js";
import type { ApiKeyResolver } from "../lib/api-key-resolver.js";
import type { BatchWriter } from "../lib/batch-writer.js";
import { RateLimiter } from "../lib/rate-limiter.js";

const JWT_SECRET = "test-jwt-secret";
const TEST_KEY_A = "yav_aaaa1111bbbb2222cccc3333dddd4444";
const TEST_KEY_B = "yav_xxxx1111yyyy2222zzzz3333wwww4444";

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

describe("Concurrency scenarios", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("concurrent requests from different API keys all succeed and attribute correctly", async () => {
    const enqueuedEvents: Record<string, unknown>[] = [];
    const bw = {
      enqueue: (events: unknown[]) => {
        enqueuedEvents.push(...(events as Record<string, unknown>[]));
        return false;
      },
    } as unknown as BatchWriter;

    const resolver = {
      resolve: vi.fn().mockImplementation(async (key: string) => {
        if (key === TEST_KEY_A) return { projectId: "proj-a", workspaceId: "ws-a" };
        if (key === TEST_KEY_B) return { projectId: "proj-b", workspaceId: "ws-b" };
        return null;
      }),
      clearCache: () => {},
    } as unknown as ApiKeyResolver;

    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      apiKeyResolver: resolver,
      jwtSecret: JWT_SECRET,
      batchWriter: bw,
      logger: false,
    });

    const results = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${TEST_KEY_A}` },
        payload: { events: [makeEvent({ event_name: "from_a" })] },
      }),
      app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${TEST_KEY_B}` },
        payload: { events: [makeEvent({ event_name: "from_b" })] },
      }),
      app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${TEST_KEY_A}` },
        payload: { events: [makeEvent({ event_name: "from_a_2" })] },
      }),
    ]);

    for (const r of results) {
      expect(r.statusCode).toBe(200);
    }

    expect(enqueuedEvents).toHaveLength(3);

    const fromA = enqueuedEvents.filter((e) => e.project_id === "proj-a");
    const fromB = enqueuedEvents.filter((e) => e.project_id === "proj-b");
    expect(fromA).toHaveLength(2);
    expect(fromB).toHaveLength(1);
  });

  it("concurrent requests from same IP: some pass, some get rate-limited", async () => {
    const rateLimiter = new RateLimiter(
      { burstCapacity: 10_000, ratePerSecond: 10_000 },
      { burstCapacity: 2, ratePerSecond: 1 },
    );

    const resolver = {
      resolve: async () => ({ projectId: "p1", workspaceId: "w1" }),
      clearCache: () => {},
    } as unknown as ApiKeyResolver;

    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      apiKeyResolver: resolver,
      jwtSecret: JWT_SECRET,
      rateLimiter,
      logger: false,
    });

    // Send 5 concurrent requests — with burstCapacity of 2, some should be rate-limited
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          method: "POST",
          url: "/v1/events",
          headers: { authorization: `Bearer ${TEST_KEY_A}` },
          payload: { events: [makeEvent()] },
        }),
      ),
    );

    const successes = results.filter((r) => r.statusCode === 200);
    const rateLimited = results.filter((r) => r.statusCode === 429);

    expect(successes.length).toBeGreaterThanOrEqual(1);
    expect(rateLimited.length).toBeGreaterThanOrEqual(1);
    expect(successes.length + rateLimited.length).toBe(5);
  });

  it("concurrent batch writer enqueues do not corrupt buffer", async () => {
    const insertFn = vi.fn().mockResolvedValue(undefined);
    const ch = {
      insert: insertFn,
      ping: async () => ({ success: true }),
    } as unknown as ClickHouseClient;

    const { BatchWriter } = await import("../lib/batch-writer.js");
    const writer = new BatchWriter({
      clickhouse: ch,
      flushSize: 10_000,
      maxBufferSize: 100_000,
    });

    // Enqueue many small batches concurrently
    const batchCount = 50;
    const eventsPerBatch = 10;
    const results = await Promise.all(
      Array.from({ length: batchCount }, () => {
        const events = Array.from({ length: eventsPerBatch }, (_, i) => ({
          event_id: randomUUID(),
          event_type: "track",
          trace_id: `trace-${i}`,
          session_id: "ses-1",
          timestamp: new Date().toISOString(),
          source: "server",
          workspace_id: "ws-1",
          project_id: "proj-1",
          ingested_at: new Date().toISOString(),
        }));
        return Promise.resolve(writer.enqueue(events));
      }),
    );

    // No backpressure on any call
    expect(results.every((r) => r === false)).toBe(true);

    // Total buffered should be exactly batchCount * eventsPerBatch
    expect(writer.bufferedCount).toBe(batchCount * eventsPerBatch);

    await writer.shutdown();
  });
});
