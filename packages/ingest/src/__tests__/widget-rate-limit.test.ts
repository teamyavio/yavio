import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../index.js";
import type { ApiKeyResolver } from "../lib/api-key-resolver.js";
import type { BatchWriter } from "../lib/batch-writer.js";
import { jwtSign } from "../lib/jwt.js";
import { RateLimiter, type RateLimiterConfig } from "../lib/rate-limiter.js";

// Widget-token requests are charged by event count, like API-key requests,
// to a bucket of their own per widget token: the project and the token's
// trace (the JWT's `pid` and `tid`).

const JWT_SECRET = "widget-rate-limit-secret";
const API_KEY = "yav_abc123def456abc123def456abc123de";
const PROJECT = "11111111-1111-1111-1111-111111111111";
const WORKSPACE = "22222222-2222-2222-2222-222222222222";

function widgetToken(traceId: string, projectId = PROJECT): string {
  const now = Math.floor(Date.now() / 1000);
  return jwtSign(
    { pid: projectId, wid: WORKSPACE, tid: traceId, sid: "ses-1", iat: now, exp: now + 900 },
    JWT_SECRET,
  );
}

function widgetEvents(traceId: string, n: number) {
  return Array.from({ length: n }, () => ({
    event_id: randomUUID(),
    event_type: "widget_click",
    trace_id: traceId,
    session_id: "ses-1",
    timestamp: new Date().toISOString(),
    source: "widget",
  }));
}

function serverEvents(n: number) {
  return Array.from({ length: n }, () => ({
    event_id: randomUUID(),
    event_type: "track",
    trace_id: "trace-server",
    session_id: "ses-1",
    timestamp: new Date().toISOString(),
    source: "server",
  }));
}

describe("widget-token rate limit", () => {
  let app: FastifyInstance;
  let enqueue: ReturnType<typeof vi.fn>;

  afterEach(async () => {
    vi.useRealTimers();
    await app?.close();
  });

  async function build(rateLimiter: RateLimiter) {
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
      rateLimiter,
      logger: false,
    });
  }

  const limiter = (widget: Partial<RateLimiterConfig>, apiKey?: Partial<RateLimiterConfig>) =>
    new RateLimiter(apiKey, undefined, widget);

  const widgetBatch = (traceId: string, n: number, token = widgetToken(traceId)) =>
    app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token}` },
      payload: { events: widgetEvents(traceId, n) },
    });

  const keyedBatch = (n: number) =>
    app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { events: serverEvents(n) },
    });

  it("passes normal widget batches and answers a burst beyond the token's bucket with 429", async () => {
    await build(limiter({ burstCapacity: 60, ratePerSecond: 0.001 }));

    for (let i = 0; i < 3; i++) {
      expect((await widgetBatch("trace-a", 20)).statusCode).toBe(200);
    }
    const refused = await widgetBatch("trace-a", 1);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe("YAVIO-2053");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect(enqueue).toHaveBeenCalledTimes(3);
  });

  it("charges by event count, not by request", async () => {
    await build(limiter({ burstCapacity: 30, ratePerSecond: 0.001 }));

    expect((await widgetBatch("trace-a", 20)).statusCode).toBe(200);
    // 20 of 30 used: a second batch of 20 does not fit, one of 10 does.
    expect((await widgetBatch("trace-a", 20)).statusCode).toBe(429);
    expect((await widgetBatch("trace-a", 10)).statusCode).toBe(200);
  });

  it("with the default limits, passes a widget's batches and its teardown beacon, and refuses beyond the burst", async () => {
    // Only Date is faked: the bucket refills from Date.now(), and fastify's
    // inject keeps its real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    await build(new RateLimiter());
    const token = widgetToken("trace-default");

    // A widget's regular batches (20 events each) and a 200-event beacon.
    for (let i = 0; i < 10; i++) {
      expect((await widgetBatch("trace-default", 20, token)).statusCode).toBe(200);
    }
    const beacon = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      payload: JSON.stringify({ token, events: widgetEvents("trace-default", 200) }),
    });
    expect(beacon.statusCode).toBe(200);

    // 400 of the 1,000-event burst used; 30 more batches of 20 use it up.
    for (let i = 0; i < 30; i++) {
      expect((await widgetBatch("trace-default", 20, token)).statusCode).toBe(200);
    }
    const refused = await widgetBatch("trace-default", 20, token);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe("YAVIO-2053");

    // 50 events per second refill it.
    vi.setSystemTime(Date.now() + 1_000);
    expect((await widgetBatch("trace-default", 20, token)).statusCode).toBe(200);
  });

  it("answers a widget batch over the cap 429 from the token's bucket, before the cap check", async () => {
    await build(new RateLimiter());

    const r = await widgetBatch("trace-over", 1_001);
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe("YAVIO-2053");
    expect(enqueue).not.toHaveBeenCalled();
    // Refused without a charge: the token's next normal batch passes.
    expect((await widgetBatch("trace-over", 20)).statusCode).toBe(200);
  });

  it("gives each widget token (trace) its own bucket", async () => {
    await build(limiter({ burstCapacity: 20, ratePerSecond: 0.001 }));

    expect((await widgetBatch("trace-a", 20)).statusCode).toBe(200);
    expect((await widgetBatch("trace-a", 1)).statusCode).toBe(429);
    expect((await widgetBatch("trace-b", 20)).statusCode).toBe(200);
    // The same trace id under another project is another token, too.
    const other = "33333333-3333-3333-3333-333333333333";
    expect((await widgetBatch("trace-a", 20, widgetToken("trace-a", other))).statusCode).toBe(200);
  });

  it("charges a widget beacon (token in the body) the same way", async () => {
    await build(limiter({ burstCapacity: 20, ratePerSecond: 0.001 }));
    const token = widgetToken("trace-beacon");
    const beacon = (n: number) =>
      app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "content-type": "text/plain;charset=UTF-8" },
        payload: JSON.stringify({ token, events: widgetEvents("trace-beacon", n) }),
      });

    expect((await beacon(20)).statusCode).toBe(200);
    const refused = await beacon(1);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe("YAVIO-2053");
  });

  it("charges a widget-token request whose body fails to parse one unit", async () => {
    await build(limiter({ burstCapacity: 3, ratePerSecond: 0.001 }));
    const token = widgetToken("trace-a");
    const malformed = () =>
      app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: "{not json",
      });

    for (let i = 0; i < 3; i++) expect((await malformed()).statusCode).toBe(400);
    const refused = await widgetBatch("trace-a", 1, token);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe("YAVIO-2053");
  });

  it("does not draw widget traffic from the project's API-key bucket", async () => {
    await build(
      limiter(
        { burstCapacity: 1_000, ratePerSecond: 50 },
        { burstCapacity: 5, ratePerSecond: 0.001 },
      ),
    );

    for (let i = 0; i < 5; i++) {
      expect((await widgetBatch("trace-a", 20)).statusCode).toBe(200);
    }
    // The key's 5-event bucket is untouched by the 100 widget events.
    expect((await keyedBatch(5)).statusCode).toBe(200);
    const refused = await keyedBatch(1);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe("YAVIO-2050");
  });

  it("leaves the API-key path as it was: charged per event, not to any widget bucket", async () => {
    await build(
      limiter(
        { burstCapacity: 1, ratePerSecond: 0.001 },
        { burstCapacity: 30, ratePerSecond: 0.001 },
      ),
    );

    expect((await keyedBatch(20)).statusCode).toBe(200);
    expect((await keyedBatch(10)).statusCode).toBe(200);
    const refused = await keyedBatch(1);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe("YAVIO-2050");
    // The widget token of the same project still has its own (1-event) budget.
    expect((await widgetBatch("trace-a", 1)).statusCode).toBe(200);
  });
});
