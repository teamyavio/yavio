import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../index.js";
import type { ApiKeyResolver } from "../lib/api-key-resolver.js";
import type { BatchWriter } from "../lib/batch-writer.js";
import { jwtSign } from "../lib/jwt.js";

// #96: widget beacons (navigator.sendBeacon) cannot set headers. They send
// `{ token, events, ... }` as text/plain; ingest parses it as JSON on the
// events route only and authenticates the widget JWT from the body.

const JWT_SECRET = "beacon-test-secret";
const API_KEY = "yav_abc123def456abc123def456abc123de";
const PROJECT = "11111111-1111-1111-1111-111111111111";
const WORKSPACE = "22222222-2222-2222-2222-222222222222";

function widgetToken(traceId: string): string {
  const now = Math.floor(Date.now() / 1000);
  return jwtSign(
    { pid: PROJECT, wid: WORKSPACE, tid: traceId, sid: "ses-1", iat: now, exp: now + 900 },
    JWT_SECRET,
  );
}

function widgetEvent(traceId: string) {
  return {
    event_id: randomUUID(),
    event_type: "widget_render",
    trace_id: traceId,
    session_id: "ses-1",
    timestamp: new Date().toISOString(),
    source: "widget",
  };
}

describe("widget beacon (#96)", () => {
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
        resolve: async (key: string) =>
          key === API_KEY ? { projectId: PROJECT, workspaceId: WORKSPACE } : null,
        clearCache: () => {},
      } as unknown as ApiKeyResolver,
      jwtSecret: JWT_SECRET,
      batchWriter: { enqueue } as unknown as BatchWriter,
      logger: false,
    });
  }

  const beacon = (body: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { "content-type": "text/plain;charset=UTF-8", ...headers },
      payload: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("accepts a text/plain beacon authenticated by the token in its body", async () => {
    await build();
    const trace = "trace-beacon";
    const event = widgetEvent(trace);

    const r = await beacon({ token: widgetToken(trace), events: [event], sdk_version: "x" });

    expect(r.statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledOnce();
    const stored = enqueue.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(stored.map((e) => e.event_id)).toEqual([event.event_id]);
    expect(stored[0].project_id).toBe(PROJECT);
    // The token is never stored.
    expect(JSON.stringify(stored)).not.toContain(widgetToken(trace).split(".")[2]);
  });

  it("lets the Authorization header win over a body token", async () => {
    await build();
    // Events belong to trace A. Header token is for A, body token for B: the
    // header must decide, or the JWT trace check would reject the batch.
    const r = await beacon(
      { token: widgetToken("trace-B"), events: [widgetEvent("trace-A")] },
      { authorization: `Bearer ${widgetToken("trace-A")}` },
    );
    expect(r.statusCode).toBe(200);

    const reversed = await beacon(
      { token: widgetToken("trace-A"), events: [widgetEvent("trace-A")] },
      { authorization: `Bearer ${widgetToken("trace-B")}` },
    );
    expect(reversed.statusCode).toBe(400);
  });

  it("returns 401 with neither a header nor a body token", async () => {
    await build();
    const r = await beacon({ events: [widgetEvent("trace-1")] });
    expect(r.statusCode).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("accepts only a widget token in the body, not an API key", async () => {
    await build();
    const r = await beacon({ token: API_KEY, events: [widgetEvent("trace-1")] });
    expect(r.statusCode).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("answers 400 to a text/plain body that is not JSON", async () => {
    await build();
    const r = await beacon("not json {");
    expect(r.statusCode).toBe(400);
  });

  it("does not parse text/plain as JSON on any other route", async () => {
    await build();
    // Valid JSON and a valid API key: parsed as JSON this would mint a token.
    const r = await app.inject({
      method: "POST",
      url: "/v1/widget-tokens",
      headers: { "content-type": "text/plain", authorization: `Bearer ${API_KEY}` },
      payload: JSON.stringify({ traceId: "t", sessionId: "s" }),
    });
    expect(r.statusCode).not.toBe(200);
  });

  it("still accepts the regular JSON request with the header", async () => {
    await build();
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${widgetToken("trace-json")}` },
      payload: { events: [widgetEvent("trace-json")] },
    });
    expect(r.statusCode).toBe(200);
  });
});
