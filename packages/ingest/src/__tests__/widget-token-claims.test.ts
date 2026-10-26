import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../index.js";
import type { ApiKeyResolver } from "../lib/api-key-resolver.js";
import type { BatchWriter } from "../lib/batch-writer.js";
import { jwtSign } from "../lib/jwt.js";
import { widgetTokenBucket } from "../plugins/rate-limit.js";

// A widget token's traceId and sessionId are bounded like the event fields
// they must match (trace_id, session_id: 128 characters), at mint and when a
// token is presented; the token's rate-limit bucket key has a fixed length.

const JWT_SECRET = "widget-token-claims-secret";
const API_KEY = "yav_abc123def456abc123def456abc123de";
const PROJECT = "11111111-1111-1111-1111-111111111111";
const WORKSPACE = "22222222-2222-2222-2222-222222222222";

function token(tid: string, sid = "ses-1"): string {
  const now = Math.floor(Date.now() / 1000);
  return jwtSign({ pid: PROJECT, wid: WORKSPACE, tid, sid, iat: now, exp: now + 900 }, JWT_SECRET);
}

function widgetEvent(traceId: string, sessionId = "ses-1") {
  return {
    event_id: randomUUID(),
    event_type: "widget_render",
    trace_id: traceId,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    source: "widget",
  };
}

describe("widget-token claims", () => {
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

  const mint = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/v1/widget-tokens",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload,
    });

  it("mints a token for a traceId and sessionId of 128 characters", async () => {
    await build();
    const r = await mint({ traceId: "t".repeat(128), sessionId: "s".repeat(128) });
    expect(r.statusCode).toBe(200);
  });

  it("refuses to mint for a traceId over 128 characters", async () => {
    await build();
    const r = await mint({ traceId: "t".repeat(129), sessionId: "ses-1" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("YAVIO-2300");
  });

  it("refuses to mint for a sessionId over 128 characters", async () => {
    await build();
    const r = await mint({ traceId: "trace-1", sessionId: "s".repeat(129) });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("YAVIO-2301");
  });

  it("refuses to mint for a traceId or sessionId that is not a string", async () => {
    await build();
    expect((await mint({ traceId: 12345, sessionId: "ses-1" })).statusCode).toBe(400);
    expect((await mint({ traceId: "trace-1", sessionId: { a: 1 } })).statusCode).toBe(400);
  });

  it("answers 401 to a token whose tid is over 128 characters", async () => {
    await build();
    const tid = "t".repeat(129);
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token(tid)}` },
      payload: { events: [widgetEvent(tid)] },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("YAVIO-2004");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("answers 401 to a token whose sid is over 128 characters, also in a beacon body", async () => {
    await build();
    const sid = "s".repeat(129);
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      payload: JSON.stringify({ token: token("trace-1", sid), events: [widgetEvent("trace-1")] }),
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("YAVIO-2004");
  });

  it("still accepts a token whose tid and sid are 128 characters", async () => {
    await build();
    const tid = "t".repeat(128);
    const sid = "s".repeat(128);
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token(tid, sid)}` },
      payload: { events: [widgetEvent(tid, sid)] },
    });
    expect(r.statusCode).toBe(200);
  });

  it("keys the token's bucket with a fixed length, whatever the trace id", () => {
    const keyFor = (traceId: string) =>
      widgetTokenBucket({
        projectId: PROJECT,
        workspaceId: WORKSPACE,
        source: "jwt",
        traceId,
        sessionId: "ses-1",
      });
    const short = keyFor("t");
    const long = keyFor("t".repeat(10_000));
    expect(long).toHaveLength(short.length);
    expect(short).toHaveLength(43);
    expect(keyFor("trace-a")).not.toBe(keyFor("trace-b"));
    expect(keyFor("trace-a")).toBe(keyFor("trace-a"));
  });
});
