import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../index.js";
import type { ApiKeyResolver } from "../lib/api-key-resolver.js";
import type { BatchWriter } from "../lib/batch-writer.js";
import { MAX_FUTURE_MS } from "../lib/event-normalizer.js";

// #90 at the route: what reaches the batch writer.

const KEY = "yav_abc123def456abc123def456abc123de";

describe("POST /v1/events — ingest hardening (#90)", () => {
  let app: FastifyInstance;
  let enqueue: ReturnType<typeof vi.fn>;

  afterEach(async () => {
    await app?.close();
  });

  async function send(events: Array<Record<string, unknown>>) {
    enqueue = vi.fn().mockReturnValue(false);
    app = await createApp({
      db: { execute: async () => [{ "?column?": 1 }] } as unknown as Database,
      clickhouse: { ping: async () => ({ success: true }) } as unknown as ClickHouseClient,
      apiKeyResolver: {
        resolve: async () => ({
          projectId: "11111111-1111-1111-1111-111111111111",
          workspaceId: "22222222-2222-2222-2222-222222222222",
        }),
        clearCache: () => {},
      } as unknown as ApiKeyResolver,
      jwtSecret: "s",
      batchWriter: { enqueue } as unknown as BatchWriter,
      logger: false,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${KEY}` },
      payload: { events },
    });
    const stored = (enqueue.mock.calls[0]?.[0] ?? []) as Array<Record<string, unknown>>;
    return { response, stored };
  }

  function event(overrides: Record<string, unknown> = {}) {
    return {
      event_id: randomUUID(),
      event_type: "tool_call",
      trace_id: "trace-1",
      session_id: "session-1",
      timestamp: new Date().toISOString(),
      source: "server",
      ...overrides,
    };
  }

  it("stores an event dated a year ahead, clamped to now + 5 min", async () => {
    const before = Date.now();
    const inAYear = new Date(before + 365 * 86_400_000).toISOString();
    const { response, stored } = await send([event({ timestamp: inAYear })]);

    expect(response.statusCode).toBe(200);
    expect(stored).toHaveLength(1);
    // The enricher writes ClickHouse's format: "YYYY-MM-DD hh:mm:ss.sss", UTC.
    const storedMs = Date.parse(`${String(stored[0].timestamp).replace(" ", "T")}Z`);
    expect(storedMs).toBeGreaterThanOrEqual(before + MAX_FUTURE_MS - 1);
    expect(storedMs).toBeLessThanOrEqual(Date.now() + MAX_FUTURE_MS);
  });

  it("stores track('quote_jane@example.com') as [EMAIL_REDACTED]", async () => {
    const { stored } = await send([
      event({ event_type: "track", event_name: "quote_jane@example.com" }),
    ]);
    expect(stored[0].event_name).toBe("[EMAIL_REDACTED]");
  });

  it("NULLs invalid country/currency/locale and keeps the event", async () => {
    const { response, stored } = await send([
      event({ country_code: "ZZ", locale: "en_US" }),
      event({ event_type: "conversion", conversion_currency: "ABC" }),
      event({ country_code: "XK", locale: "de-de" }),
    ]);
    expect(response.statusCode).toBe(200);
    expect(stored).toHaveLength(3);
    expect(stored[0].country_code).toBeNull();
    expect(stored[0].locale).toBeNull();
    expect(stored[1].conversion_currency).toBeNull();
    expect(stored[2].country_code).toBe("XK");
    expect(stored[2].locale).toBe("de-DE");
  });

  it("stores ids verbatim even when they contain phone-shaped digit runs", async () => {
    const id = "47e16ee3-3d22-430b-acb1-959114949231";
    const { stored } = await send([
      event({ event_id: id, trace_id: "tr_4155550134", session_id: "a83947291834ab5550134" }),
    ]);
    expect(stored[0].event_id).toBe(id);
    expect(stored[0].trace_id).toBe("tr_4155550134");
    expect(stored[0].session_id).toBe("a83947291834ab5550134");
  });
});
