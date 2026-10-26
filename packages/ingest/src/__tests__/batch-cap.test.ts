import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import { IngestBatch, IngestEvent, MAX_BATCH_EVENTS } from "@yavio/shared/events";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../index.js";
import type { ApiKeyResolver } from "../lib/api-key-resolver.js";
import type { BatchWriter } from "../lib/batch-writer.js";
import { validateBatch } from "../lib/schema-validator.js";

// The batch cap: a POST /v1/events batch holds at most MAX_BATCH_EVENTS
// events. A longer one is rejected whole, before any of it is parsed, and a
// response lists at most 100 per-event errors (`rejected` counts them all).

const TEST_KEY = "yav_abc123def456abc123def456abc123de";
const CAP_ISSUE = `events: Too big: expected array to have <=${MAX_BATCH_EVENTS} items`;

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

const validEvents = (n: number) => Array.from({ length: n }, () => makeEvent());
const invalidElements = (n: number) => Array.from({ length: n }, (_, i) => ({ bad: i }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateBatch — the batch cap", () => {
  it("rejects a batch one over the cap with a single error and parses none of it", () => {
    const batchParse = vi.spyOn(IngestBatch, "safeParse");
    const eventParse = vi.spyOn(IngestEvent, "safeParse");

    const result = validateBatch({ events: validEvents(MAX_BATCH_EVENTS + 1) });

    expect(result.valid).toHaveLength(0);
    expect(result.errors).toEqual([{ index: -1, issues: [CAP_ISSUE] }]);
    expect(batchParse).not.toHaveBeenCalled();
    expect(eventParse).not.toHaveBeenCalled();
  });

  it("does not run the per-event fallback for an over-cap array of invalid elements", () => {
    const eventParse = vi.spyOn(IngestEvent, "safeParse");

    const result = validateBatch({ events: invalidElements(MAX_BATCH_EVENTS * 3) });

    expect(eventParse).not.toHaveBeenCalled();
    expect(result.valid).toHaveLength(0);
    expect(result.errors).toEqual([{ index: -1, issues: [CAP_ISSUE] }]);
  });

  it("accepts a batch of exactly the cap", () => {
    const result = validateBatch({ events: validEvents(MAX_BATCH_EVENTS) });
    expect(result.valid).toHaveLength(MAX_BATCH_EVENTS);
    expect(result.errors).toHaveLength(0);
  });

  it("still runs the per-event fallback within the cap", () => {
    const eventParse = vi.spyOn(IngestEvent, "safeParse");
    const events = [...validEvents(MAX_BATCH_EVENTS - 1), { bad: "event" }];

    const result = validateBatch({ events });

    expect(eventParse).toHaveBeenCalledTimes(MAX_BATCH_EVENTS);
    expect(result.valid).toHaveLength(MAX_BATCH_EVENTS - 1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].index).toBe(MAX_BATCH_EVENTS - 1);
  });
});

describe("POST /v1/events — the batch cap", () => {
  let app: FastifyInstance;
  let enqueue: ReturnType<typeof vi.fn>;

  afterEach(async () => {
    await app?.close();
  });

  async function build() {
    enqueue = vi.fn().mockReturnValue(false);
    app = await createApp({
      db: { execute: async () => [{ "?column?": 1 }] } as unknown as Database,
      clickhouse: { ping: async () => ({ success: true }) } as unknown as ClickHouseClient,
      apiKeyResolver: {
        resolve: async () => ({ projectId: "p1", workspaceId: "w1" }),
        clearCache: () => {},
      } as unknown as ApiKeyResolver,
      jwtSecret: "test-secret",
      batchWriter: { enqueue } as unknown as BatchWriter,
      logger: false,
    });
  }

  const post = (events: unknown) =>
    app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { events },
    });

  it("answers a batch one over the cap with one cap error and stores nothing", async () => {
    await build();
    const r = await post(validEvents(MAX_BATCH_EVENTS + 1));

    expect(r.statusCode).toBe(400);
    const body = r.json();
    expect(body.error.code).toBe("YAVIO-2100");
    expect(body.error.message).toBe(`Batch exceeds ${MAX_BATCH_EVENTS} events`);
    expect(body.errors).toEqual([{ index: -1, issues: [CAP_ISSUE] }]);
    expect(body.accepted).toBe(0);
    expect(body.rejected).toBe(MAX_BATCH_EVENTS + 1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("accepts a batch of exactly the cap", async () => {
    await build();
    const r = await post(validEvents(MAX_BATCH_EVENTS));

    expect(r.statusCode).toBe(200);
    expect(r.json().accepted).toBe(MAX_BATCH_EVENTS);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0][0]).toHaveLength(MAX_BATCH_EVENTS);
  });

  it("answers an over-cap array of invalid elements with the one cap error, without the per-event fallback", async () => {
    await build();
    const eventParse = vi.spyOn(IngestEvent, "safeParse");

    const r = await post(Array.from({ length: MAX_BATCH_EVENTS * 3 }, () => ({})));

    expect(r.statusCode).toBe(400);
    expect(eventParse).not.toHaveBeenCalled();
    const body = r.json();
    expect(body.errors).toEqual([{ index: -1, issues: [CAP_ISSUE] }]);
    expect(body.rejected).toBe(MAX_BATCH_EVENTS * 3);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("lists the first 100 per-event errors of an all-invalid batch within the cap; rejected counts all", async () => {
    await build();
    const r = await post(invalidElements(MAX_BATCH_EVENTS));

    expect(r.statusCode).toBe(400);
    const body = r.json();
    expect(body.error.code).toBe("YAVIO-2100");
    expect(body.accepted).toBe(0);
    expect(body.rejected).toBe(MAX_BATCH_EVENTS);
    expect(body.errors).toHaveLength(100);
    // The existing per-event shape, in index order.
    expect(body.errors.map((e: { index: number }) => e.index)).toEqual(
      Array.from({ length: 100 }, (_, i) => i),
    );
    for (const entry of body.errors) {
      expect(Object.keys(entry).sort()).toEqual(["index", "issues"]);
      expect(entry.issues.length).toBeGreaterThan(0);
      for (const issue of entry.issues) expect(typeof issue).toBe("string");
    }
  });

  it("keeps partial acceptance (207) within the cap and lists the first 100 errors", async () => {
    await build();
    const events = [...validEvents(10), ...invalidElements(500)];
    const r = await post(events);

    expect(r.statusCode).toBe(207);
    const body = r.json();
    expect(body.accepted).toBe(10);
    expect(body.rejected).toBe(500);
    expect(body.errors).toHaveLength(100);
    expect(body.errors[0].index).toBe(10);
    expect(body.errors[99].index).toBe(109);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0][0]).toHaveLength(10);
  });

  it("lists every error when a partial batch has no more than 100", async () => {
    await build();
    const events = [...validEvents(5), ...invalidElements(100)];
    const r = await post(events);

    expect(r.statusCode).toBe(207);
    const body = r.json();
    expect(body.rejected).toBe(100);
    expect(body.errors).toHaveLength(100);
  });

  it("answers an empty events array as before", async () => {
    await build();
    const r = await post([]);

    expect(r.statusCode).toBe(400);
    const body = r.json();
    expect(body.error.code).toBe("YAVIO-2100");
    expect(body.error.message).toBe("All events failed validation");
    expect(body.errors).toEqual([
      { index: -1, issues: ["events: Too small: expected array to have >=1 items"] },
    ]);
    expect(body.accepted).toBe(0);
    expect(body.rejected).toBe(1);
  });

  it("answers a non-array events field as before", async () => {
    await build();
    const r = await post("not-an-array");

    expect(r.statusCode).toBe(400);
    const body = r.json();
    expect(body.error.code).toBe("YAVIO-2100");
    expect(body.error.message).toBe("All events failed validation");
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].index).toBe(-1);
    expect(body.accepted).toBe(0);
    expect(body.rejected).toBe(1);
  });
});
