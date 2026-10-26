import { randomUUID } from "node:crypto";
import { ClickHouseError } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../index.js";
import type { ApiKeyResolver } from "../../lib/api-key-resolver.js";
import {
  BatchWriter,
  RESOURCE_ERROR_CODES,
  ROW_ERROR_CODES,
  SERVER_ERROR_CODES,
} from "../../lib/batch-writer.js";
import type { EnrichedEvent } from "../../lib/event-enricher.js";
import { mapToolRegistryRow } from "../../lib/tool-registry.js";
import { disconnect, getClient, runMigrations } from "./helpers/clickhouse-setup.js";

// Rows the events table refuses, against a real ClickHouse (the CI service,
// 26.8). The bad rows are handed to the writer directly: the schema bounds
// them at the door, so this is what reaches ClickHouse when a value slips
// past it.

function row(workspace: string, extra: Record<string, unknown> = {}): EnrichedEvent {
  return {
    event_id: randomUUID(),
    event_type: "tool_call",
    trace_id: "trace-isolation",
    session_id: "session-isolation",
    timestamp: new Date().toISOString().replace("T", " ").replace("Z", ""),
    source: "server",
    workspace_id: workspace,
    project_id: "p-isolation",
    ...extra,
  };
}

async function storedIds(workspace: string): Promise<string[]> {
  const result = await getClient().query({
    query: "SELECT event_id FROM events WHERE workspace_id = {ws:String}",
    query_params: { ws: workspace },
    format: "JSONEachRow",
  });
  return (await result.json<{ event_id: string }>()).map((r) => r.event_id).sort();
}

function ids(rows: EnrichedEvent[]): string[] {
  return rows.map((r) => String(r.event_id)).sort();
}

describe("an event a column cannot store, buffered with valid events", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("no longer fails their insert: the valid events are stored, the refused ones dropped and logged once, and the next flush goes through", async () => {
    const workspace = `ws-isolation-${randomUUID()}`;
    const warn = vi.fn();
    const writer = new BatchWriter({ clickhouse: getClient(), flushSize: 1_000, logger: { warn } });

    const good = Array.from({ length: 60 }, () => row(workspace));
    const bad = [
      row(workspace, { tokens_in: -1 }), // Nullable(UInt32): CANNOT_PARSE_NUMBER
      row(workspace, { event_type: "step", step_sequence: 1e21 }), // "1e+21" into UInt32
      row(workspace, { event_type: "widget_render", viewport_width: 1.5 }), // a fraction into UInt16
    ];
    writer.enqueue([
      ...good.slice(0, 10),
      bad[0],
      ...good.slice(10, 40),
      bad[1],
      bad[2],
      ...good.slice(40),
    ]);
    await writer.flush();

    expect(await storedIds(workspace)).toEqual(ids(good));
    expect(writer.bufferedCount).toBe(0);
    // ClickHouse names each refused row: refused in the batch and alone, it
    // is dropped in the same flush.
    expect(writer.keptCount).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, details] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toMatch(/3 events/);
    expect(details).toMatchObject({
      dropped: 3,
      event_ids: expect.arrayContaining(ids(bad)),
      project_ids: ["p-isolation"],
    });
    // Ids and error names only, never a field value.
    const logged = JSON.stringify(warn.mock.calls);
    for (const field of ["tokens_in", "step_sequence", "viewport_width", "1e+21", "1.5"]) {
      expect(logged).not.toContain(field);
    }

    const next = Array.from({ length: 5 }, () => row(workspace));
    writer.enqueue(next);
    await writer.flush();
    expect(await storedIds(workspace)).toEqual(ids([...good, ...next]));
    expect(writer.bufferedCount).toBe(0);
  }, 30_000);

  it.each([
    ["ROW_ERROR_CODES", ROW_ERROR_CODES],
    ["SERVER_ERROR_CODES", SERVER_ERROR_CODES],
    ["RESOURCE_ERROR_CODES", RESOURCE_ERROR_CODES],
  ])("names the codes of %s as ClickHouse does", async (_, map) => {
    const result = await getClient().query({
      query: "SELECT arrayMap(c -> errorCodeToName(c), {codes:Array(UInt32)}) AS names",
      query_params: { codes: [...map.keys()] },
      format: "JSONEachRow",
    });
    const [{ names }] = await result.json<{ names: string[] }>();
    expect(names).toEqual([...map.values()]);
  });

  it("names the first refused row in its message, also with parallel parsing over 10 MiB", async () => {
    const workspace = `ws-isolation-named-${randomUUID()}`;
    const pad = "x".repeat(400);
    const rows = Array.from({ length: 30_000 }, (_, i) =>
      row(workspace, i === 25_000 ? { tokens_in: -1, error_message: pad } : { error_message: pad }),
    );
    const error = await getClient()
      .insert({ table: "events", values: rows, format: "JSONEachRow" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClickHouseError);
    expect((error as ClickHouseError).message).toMatch(/\(at row 25001\)/);
  }, 60_000);

  it("bounds each numeric field by the type its column has", async () => {
    // The column side of the table in @yavio/shared numeric-bounds.test.ts.
    const expected: Record<string, string> = {
      latency_ms: "Nullable(Float64)",
      is_retry: "UInt8",
      tokens_in: "Nullable(UInt32)",
      tokens_out: "Nullable(UInt32)",
      connection_duration_ms: "Nullable(Float64)",
      step_sequence: "Nullable(UInt32)",
      conversion_value: "Nullable(Float64)",
      viewport_width: "Nullable(UInt16)",
      viewport_height: "Nullable(UInt16)",
      device_pixel_ratio: "Nullable(Float32)",
      device_touch: "Nullable(UInt8)",
      visible_duration_ms: "Nullable(Float64)",
      click_count: "Nullable(UInt32)",
      scroll_depth_pct: "Nullable(Float64)",
      load_time_ms: "Nullable(Float64)",
    };
    const result = await getClient().query({
      query:
        "SELECT name, type FROM system.columns WHERE database = currentDatabase() AND table = 'events' AND name IN {names:Array(String)}",
      query_params: { names: Object.keys(expected) },
      format: "JSONEachRow",
    });
    const columns = await result.json<{ name: string; type: string }>();
    expect(Object.fromEntries(columns.map((c) => [c.name, c.type]))).toEqual(expected);
  });

  describe("through the API", () => {
    let app: FastifyInstance;
    let writer: BatchWriter;
    let registryWriter: BatchWriter;
    const workspace = `ws-isolation-api-${randomUUID()}`;
    const project = `p-isolation-api-${randomUUID()}`;

    beforeAll(async () => {
      writer = new BatchWriter({ clickhouse: getClient(), flushSize: 100 });
      // As server.ts builds it.
      registryWriter = new BatchWriter({
        clickhouse: getClient(),
        table: "tool_registry",
        mapRow: mapToolRegistryRow,
        flushSize: 100,
        maxBufferSize: 1_000,
      });
      app = await createApp({
        db: { execute: async () => [{ "?column?": 1 }] } as unknown as Database,
        clickhouse: getClient(),
        apiKeyResolver: {
          resolve: async () => ({ projectId: project, workspaceId: workspace }),
          clearCache: () => {},
        } as unknown as ApiKeyResolver,
        jwtSecret: "s",
        batchWriter: writer,
        toolRegistryWriter: registryWriter,
        logger: false,
      });
    });

    afterEach(async () => {
      await writer.flush();
      await registryWriter.flush();
    });

    afterAll(async () => {
      await app?.close();
    });

    function event(extra: Record<string, unknown> = {}) {
      return {
        event_id: randomUUID(),
        event_type: "tool_call",
        trace_id: "trace-isolation-api",
        session_id: "session-isolation-api",
        timestamp: new Date().toISOString(),
        source: "server",
        ...extra,
      };
    }

    async function post(events: unknown[]) {
      return app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: "Bearer yav_abc123def456abc123def456abc123de" },
        payload: { events },
      });
    }

    it("rejects a number its column cannot hold per event (207) and stores the rest", async () => {
      const valid = event({ tokens_in: 4_294_967_295 });
      const response = await post([valid, event({ tokens_in: -1 })]);
      expect(response.statusCode).toBe(207);
      const body = response.json();
      expect(body).toMatchObject({ accepted: 1, rejected: 1 });
      expect(body.errors).toEqual([{ index: 1, issues: [expect.stringMatching(/^tokens_in: /)] }]);
      await writer.flush();
      expect(await storedIds(workspace)).toContain(valid.event_id);
    });

    it("stores the largest value the schema accepts for each column as sent", async () => {
      const toolCall = event({ tokens_in: 2 ** 32 - 1, tokens_out: 0, latency_ms: -1.5 });
      const render = event({
        event_type: "widget_render",
        viewport_width: 65_535,
        viewport_height: 65_535,
        device_pixel_ratio: 3.4028234663852886e38,
      });
      const step = event({ event_type: "step", step_sequence: 2 ** 32 - 1 });
      const click = event({ event_type: "widget_click", click_count: 2 ** 32 - 1 });
      const conversion = event({ event_type: "conversion", conversion_value: Number.MAX_VALUE });
      const response = await post([toolCall, render, step, click, conversion]);
      expect(response.statusCode).toBe(200);
      await writer.flush();
      expect(writer.bufferedCount).toBe(0);

      const result = await getClient().query({
        query: `SELECT event_id, toString(tokens_in) AS tokens_in, toString(tokens_out) AS tokens_out,
                  toString(latency_ms) AS latency_ms, toString(viewport_width) AS viewport_width,
                  toString(viewport_height) AS viewport_height,
                  toString(device_pixel_ratio) AS device_pixel_ratio,
                  toString(step_sequence) AS step_sequence, toString(click_count) AS click_count,
                  toString(conversion_value) AS conversion_value
                FROM events WHERE workspace_id = {ws:String} AND event_id IN {ids:Array(String)}`,
        query_params: {
          ws: workspace,
          ids: [toolCall, render, step, click, conversion].map((e) => e.event_id),
        },
        format: "JSONEachRow",
      });
      const rows = new Map(
        (await result.json<Record<string, string | null>>()).map((r) => [r.event_id, r]),
      );
      expect(rows.get(toolCall.event_id)).toMatchObject({
        tokens_in: "4294967295",
        tokens_out: "0",
        latency_ms: "-1.5",
      });
      expect(rows.get(render.event_id)).toMatchObject({
        viewport_width: "65535",
        viewport_height: "65535",
        device_pixel_ratio: "3.4028235e38", // Float32's largest, not inf
      });
      expect(rows.get(step.event_id)).toMatchObject({ step_sequence: "4294967295" });
      expect(rows.get(click.event_id)).toMatchObject({ click_count: "4294967295" });
      expect(rows.get(conversion.event_id)).toMatchObject({
        conversion_value: "1.7976931348623157e308",
      });
    });

    it("stores a timestamp sent with 20 fractional digits in milliseconds, in events and in tool_registry", async () => {
      const second = new Date(Date.now() - 60_000).toISOString().slice(0, 19);
      const timestamp = `${second}.12345678901234567890Z`;
      const call = event({ timestamp });
      const toolName = `tool-${randomUUID()}`;
      const discovery = event({ event_type: "tool_discovery", tool_name: toolName, timestamp });
      const response = await post([call, discovery]);
      expect(response.statusCode).toBe(200);
      await writer.flush();
      await registryWriter.flush();

      const expected = `${second.replace("T", " ")}.123`;
      const stored = await getClient().query({
        query: "SELECT toString(timestamp) AS t FROM events WHERE event_id = {id:String}",
        query_params: { id: call.event_id },
        format: "JSONEachRow",
      });
      expect(await stored.json()).toEqual([{ t: expected }]);
      const registered = await getClient().query({
        query:
          "SELECT toString(registered_at) AS t FROM tool_registry WHERE project_id = {p:String} AND tool_name = {name:String}",
        query_params: { p: project, name: toolName },
        format: "JSONEachRow",
      });
      expect(await registered.json()).toEqual([{ t: expected }]);
      expect(writer.bufferedCount + writer.keptCount).toBe(0);
      expect(registryWriter.bufferedCount + registryWriter.keptCount).toBe(0);
    });

    it("stores an event whose string carries a lone surrogate, with U+FFFD in its place", async () => {
      const lone = event({ event_name: "search\ud800results" });
      const plain = event({ event_name: "plain" });
      const response = await post([lone, plain]);
      expect(response.statusCode).toBe(200);
      await writer.flush();
      expect(writer.bufferedCount).toBe(0);
      const result = await getClient().query({
        query:
          "SELECT event_id, event_name FROM events WHERE workspace_id = {ws:String} AND event_id IN {ids:Array(String)}",
        query_params: { ws: workspace, ids: [lone.event_id, plain.event_id] },
        format: "JSONEachRow",
      });
      const rows = await result.json<{ event_id: string; event_name: string }>();
      expect(Object.fromEntries(rows.map((r) => [r.event_id, r.event_name]))).toEqual({
        [lone.event_id]: "search�results",
        [plain.event_id]: "plain",
      });
    });
  });
});
