import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../index.js";
import type { ApiKeyResolver } from "../lib/api-key-resolver.js";
import type { BatchWriter } from "../lib/batch-writer.js";
import { MAX_BODY_NESTING, exceedsNestingText } from "../lib/nesting.js";
import { MAX_PII_WALK_DEPTH, PII_DEPTH_MARKER, stripPii } from "../lib/pii-stripper.js";

// The events route's parsers refuse a body nested deeper than MAX_BODY_NESTING
// on its raw text, before JSON.parse. The PII walk descends MAX_PII_WALK_DEPTH
// levels and replaces anything deeper with a marker.

const API_KEY = "yav_abc123def456abc123def456abc123de";

/** `{ a: { a: { ... leaf } } }`, `levels` objects deep, as a JSON string. */
function nestedJson(levels: number, leaf: string): string {
  return `${'{"a":'.repeat(levels)}${JSON.stringify(leaf)}${"}".repeat(levels)}`;
}

/** Levels of objects and arrays in a parsed value, the value itself the first. */
function levels(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  return 1 + Math.max(0, ...Object.values(value as object).map(levels));
}

describe("exceedsNestingText", () => {
  it("counts objects and arrays, the outermost as the first level", () => {
    expect(exceedsNestingText('"x"', 0)).toBe(false);
    expect(exceedsNestingText("null", 0)).toBe(false);
    expect(exceedsNestingText("{}", 1)).toBe(false);
    expect(exceedsNestingText("{}", 0)).toBe(true);
    expect(exceedsNestingText('{"a":[{"b":1}]}', 3)).toBe(false);
    expect(exceedsNestingText('{"a":[{"b":1}]}', 2)).toBe(true);
    expect(exceedsNestingText('{"a":[1],"b":[2],"c":{"d":[3]}}', 3)).toBe(false);
    expect(exceedsNestingText(nestedJson(MAX_BODY_NESTING, "x"), MAX_BODY_NESTING)).toBe(false);
    expect(exceedsNestingText(nestedJson(MAX_BODY_NESTING + 1, "x"), MAX_BODY_NESTING)).toBe(true);
  });

  it("ignores brackets inside strings, escaped quotes and backslashes included", () => {
    expect(exceedsNestingText(JSON.stringify({ s: "[".repeat(1_000) }), 1)).toBe(false);
    const tricky = JSON.stringify({ s: 'a\\"[[[[\\', t: '"{{{{', u: "\\\\" });
    expect(exceedsNestingText(tricky, 1)).toBe(false);
    expect(exceedsNestingText(`[${tricky},[[[1]]]]`, 3)).toBe(true);
    expect(exceedsNestingText(`[${tricky},[[[1]]]]`, 4)).toBe(false);
  });

  it("agrees with the parsed structure", () => {
    const samples: unknown[] = [
      { events: [{ metadata: { a: [1, { b: "x]}" }] } }] },
      { events: [{ s: '\\"', n: [[[]]] }] },
      [[["\\\\"]], { a: { b: { c: {} } } }],
      { "k[": "v{", nested: { "]": [{ "}": [] }] } },
      JSON.parse(nestedJson(30, '"]}{["')),
    ];
    for (const sample of samples) {
      const text = JSON.stringify(sample);
      const depth = levels(sample);
      expect(exceedsNestingText(text, depth)).toBe(false);
      expect(exceedsNestingText(text, depth - 1)).toBe(true);
    }
  });

  it("answers for any depth", () => {
    expect(exceedsNestingText(`${"[".repeat(100_000)}${"]".repeat(100_000)}`, 64)).toBe(true);
  });
});

describe("stripPii — nesting depth", () => {
  it("strips strings at any depth up to the limit", () => {
    // depth 0: the batch, 1: an event, 2: its field; MAX_PII_WALK_DEPTH levels in all.
    const depth = MAX_PII_WALK_DEPTH - 2;
    const event = { metadata: JSON.parse(nestedJson(depth, "mail me: jane@example.com")) };
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

describe("POST /v1/events — nesting", () => {
  let app: FastifyInstance;
  let enqueue: ReturnType<typeof vi.fn>;
  let toolRegistry: ReturnType<typeof vi.fn>;

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
  });

  async function build() {
    enqueue = vi.fn().mockReturnValue(false);
    toolRegistry = vi.fn().mockReturnValue(false);
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
  }

  const toolEvent = (name: string) => ({
    event_id: randomUUID(),
    event_type: "tool_discovery",
    trace_id: "trace-1",
    session_id: "ses-1",
    timestamp: new Date().toISOString(),
    source: "server",
    tool_name: name,
  });

  const post = (payload: string, contentType = "application/json") =>
    app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": contentType },
      payload,
    });

  it("answers a deeply nested input_schema 400 before the body is parsed", async () => {
    await build();
    const parse = vi.spyOn(JSON, "parse");
    const eventJson = JSON.stringify(toolEvent("marker-deep-schema"));
    // input_schema nested 20,000 objects deep.
    const payload = `{"events":[${eventJson.slice(0, -1)},"input_schema":${nestedJson(20_000, "x")}}]}`;

    const r = await post(payload);

    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({
      code: "YAVIO-2100",
      message: "Body nests deeper than 64 levels",
    });
    expect(r.json().errors).toEqual([{ index: -1, issues: ["Body nests deeper than 64 levels"] }]);
    expect(r.json().rejected).toBe(1);
    expect(parse.mock.calls.some((call) => String(call[0]).includes("marker-deep-schema"))).toBe(
      false,
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(toolRegistry).not.toHaveBeenCalled();
  });

  it("answers a deeply nested text/plain body 400 before it is parsed, too", async () => {
    await build();
    const parse = vi.spyOn(JSON, "parse");
    const payload = `{"marker":"marker-deep-text","events":${"[".repeat(500)}${"]".repeat(500)}}`;

    const r = await post(payload, "text/plain;charset=UTF-8");

    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toBe("Body nests deeper than 64 levels");
    expect(parse.mock.calls.some((call) => String(call[0]).includes("marker-deep-text"))).toBe(
      false,
    );
  });

  it("accepts an input_schema nested within the limit", async () => {
    await build();
    const event = {
      ...toolEvent("nested"),
      // The body, the events array and the event: 3 levels; input_schema adds 60.
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

  it("answers a wide batch over the cap with the cap's 400, not the nesting one", async () => {
    await build();
    const payload = JSON.stringify({ events: Array.from({ length: 50_000 }, () => [{}]) });

    const r = await post(payload);

    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toBe("Batch exceeds 1000 events");
  });
});
