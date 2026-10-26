import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../index.js";
import type { ApiKeyResolver } from "../lib/api-key-resolver.js";
import type { BatchWriter } from "../lib/batch-writer.js";
import { MAX_BODY_NESTING, exceedsNesting } from "../lib/nesting.js";
import { MAX_PII_WALK_DEPTH, PII_DEPTH_MARKER, stripPii } from "../lib/pii-stripper.js";

// The PII walk stops at MAX_PII_WALK_DEPTH levels: anything nested deeper is
// replaced with a marker, so a deeply nested object cannot make it fail.

const API_KEY = "yav_abc123def456abc123def456abc123de";

/** `{ a: { a: { ... leaf } } }`, `levels` objects deep, as a JSON string. */
function nestedJson(levels: number, leaf: string): string {
  return `${'{"a":'.repeat(levels)}${JSON.stringify(leaf)}${"}".repeat(levels)}`;
}

describe("exceedsNesting", () => {
  it("counts objects and arrays, the value itself as the first level", () => {
    expect(exceedsNesting("x", 0)).toBe(false);
    expect(exceedsNesting(null, 0)).toBe(false);
    expect(exceedsNesting({}, 1)).toBe(false);
    expect(exceedsNesting({}, 0)).toBe(true);
    expect(exceedsNesting({ a: [{ b: 1 }] }, 3)).toBe(false);
    expect(exceedsNesting({ a: [{ b: 1 }] }, 2)).toBe(true);
    expect(exceedsNesting(JSON.parse(nestedJson(MAX_BODY_NESTING, "x")), MAX_BODY_NESTING)).toBe(
      false,
    );
    expect(
      exceedsNesting(JSON.parse(nestedJson(MAX_BODY_NESTING + 1, "x")), MAX_BODY_NESTING),
    ).toBe(true);
  });

  it("answers for any depth", () => {
    expect(exceedsNesting(JSON.parse(`${"[".repeat(100_000)}${"]".repeat(100_000)}`), 64)).toBe(
      true,
    );
  });
});

describe("stripPii — nesting depth", () => {
  it("strips strings at any depth up to the limit", () => {
    // depth 0: the batch, 1: an event, 2: its field; MAX_PII_WALK_DEPTH levels in all.
    const levels = MAX_PII_WALK_DEPTH - 2;
    const event = { metadata: JSON.parse(nestedJson(levels, "mail me: jane@example.com")) };
    const { result } = stripPii([event]);
    expect(JSON.stringify(result)).toContain("[EMAIL_REDACTED]");
    expect(JSON.stringify(result)).not.toContain(PII_DEPTH_MARKER);
  });

  it("replaces what lies deeper than the limit with a marker", () => {
    const event = { metadata: JSON.parse(nestedJson(MAX_PII_WALK_DEPTH + 5, "jane@example.com")) };
    const { result } = stripPii([event]);
    const json = JSON.stringify(result);
    expect(json).toContain(PII_DEPTH_MARKER);
    expect(json).not.toContain("jane@example.com");
  });

  it("keeps the shape above the limit", () => {
    const value = JSON.parse(nestedJson(MAX_PII_WALK_DEPTH + 1, "x"));
    const { result } = stripPii(value);
    let node: unknown = result;
    let depth = 0;
    while (node !== null && typeof node === "object") {
      node = (node as { a: unknown }).a;
      depth++;
    }
    expect(depth).toBe(MAX_PII_WALK_DEPTH);
    expect(node).toBe(PII_DEPTH_MARKER);
  });
});

describe("POST /v1/events — a deeply nested input_schema", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("is answered without a 500", async () => {
    const enqueue = vi.fn().mockReturnValue(false);
    const toolRegistry = vi.fn().mockReturnValue(false);
    app = await createApp({
      db: { execute: async () => [{ "?column?": 1 }] } as unknown as Database,
      clickhouse: { ping: async () => ({ success: true }) } as unknown as ClickHouseClient,
      apiKeyResolver: {
        resolve: async () => ({ projectId: "p1", workspaceId: "w1" }),
        clearCache: () => {},
      } as unknown as ApiKeyResolver,
      jwtSecret: "test-secret",
      batchWriter: { enqueue } as unknown as BatchWriter,
      toolRegistryWriter: { enqueue: toolRegistry } as unknown as BatchWriter,
      logger: false,
    });

    const event = {
      event_id: randomUUID(),
      event_type: "tool_discovery",
      trace_id: "trace-1",
      session_id: "ses-1",
      timestamp: new Date().toISOString(),
      source: "server",
      tool_name: "deep",
    };
    const eventJson = JSON.stringify(event);
    // input_schema nested 20,000 objects deep (about 120 KB).
    const payload = `{"events":[${eventJson.slice(0, -1)},"input_schema":${nestedJson(20_000, "x")}}]}`;

    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      payload,
    });

    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({
      code: "YAVIO-2100",
      message: "Body nests deeper than 64 levels",
    });
    expect(r.json().errors).toEqual([{ index: -1, issues: ["Body nests deeper than 64 levels"] }]);
    expect(r.json().rejected).toBe(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(toolRegistry).not.toHaveBeenCalled();
  });

  it("accepts an input_schema nested within the limit", async () => {
    const toolRegistry = vi.fn().mockReturnValue(false);
    app = await createApp({
      db: { execute: async () => [{ "?column?": 1 }] } as unknown as Database,
      clickhouse: { ping: async () => ({ success: true }) } as unknown as ClickHouseClient,
      apiKeyResolver: {
        resolve: async () => ({ projectId: "p1", workspaceId: "w1" }),
        clearCache: () => {},
      } as unknown as ApiKeyResolver,
      jwtSecret: "test-secret",
      toolRegistryWriter: { enqueue: toolRegistry } as unknown as BatchWriter,
      logger: false,
    });
    const event = {
      event_id: randomUUID(),
      event_type: "tool_discovery",
      trace_id: "trace-1",
      session_id: "ses-1",
      timestamp: new Date().toISOString(),
      source: "server",
      tool_name: "nested",
      // body, events, event, input_schema: 4 levels; 60 more inside.
      input_schema: JSON.parse(nestedJson(60, "x")),
    };

    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { events: [event] },
    });

    expect(r.statusCode).toBe(200);
    expect(toolRegistry).toHaveBeenCalledOnce();
  });
});
