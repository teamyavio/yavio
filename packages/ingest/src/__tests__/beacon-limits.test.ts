import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../index.js";
import type { ApiKeyResolver } from "../lib/api-key-resolver.js";
import type { BatchWriter } from "../lib/batch-writer.js";
import { jwtSign } from "../lib/jwt.js";
import { RateLimiter } from "../lib/rate-limiter.js";

// What ingest reads before a request authenticates. Only a widget beacon —
// text/plain, token in the body — is parsed without a header, and only up to
// 64 KiB (sendBeacon's own quota). With TRUST_PROXY set, header-less requests
// are charged to the address's auth-failure bucket on arrival and refunded
// once they authenticate. JSON bodies are read up to 600,000 bytes.

const JWT_SECRET = "beacon-limits-secret";
const API_KEY = "yav_abc123def456abc123def456abc123de";
const PROJECT = "11111111-1111-1111-1111-111111111111";
const WORKSPACE = "22222222-2222-2222-2222-222222222222";
const PROXY = "172.30.240.1";

function widgetToken(traceId: string): string {
  const now = Math.floor(Date.now() / 1000);
  return jwtSign(
    { pid: PROJECT, wid: WORKSPACE, tid: traceId, sid: "ses-1", iat: now, exp: now + 900 },
    JWT_SECRET,
  );
}

function widgetEvents(traceId: string, n: number, padding = 0) {
  return Array.from({ length: n }, () => ({
    event_id: randomUUID(),
    event_type: "widget_click",
    trace_id: traceId,
    session_id: "ses-1",
    timestamp: new Date().toISOString(),
    source: "widget",
    ...(padding > 0 ? { metadata: { pad: "x".repeat(padding) } } : {}),
  }));
}

/** JSON.parse calls whose input contains `marker`: which bodies were parsed. */
function parsedWith(spy: { mock: { calls: unknown[][] } }, marker: string): number {
  return spy.mock.calls.filter(
    (call) => typeof call[0] === "string" && (call[0] as string).includes(marker),
  ).length;
}

describe("events route — reading bodies before authentication", { timeout: 20_000 }, () => {
  let app: FastifyInstance;
  let enqueue: ReturnType<typeof vi.fn>;

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
  });

  async function build(opts: { rateLimiter?: RateLimiter; trustProxy?: string[] } = {}) {
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
      rateLimiter: opts.rateLimiter,
      trustProxy: opts.trustProxy,
      logger: false,
    });
    await app.ready();
  }

  const beacon = (body: string, client?: string) =>
    app.inject({
      method: "POST",
      url: "/v1/events",
      remoteAddress: client ? PROXY : "198.51.100.40",
      headers: {
        "content-type": "text/plain;charset=UTF-8",
        ...(client ? { "x-forwarded-for": client } : {}),
      },
      payload: body,
    });

  it("answers a header-less text/plain body over 64 KiB with 413, without parsing it", async () => {
    await build();
    const parse = vi.spyOn(JSON, "parse");
    const body = JSON.stringify({
      token: widgetToken("trace-big"),
      events: widgetEvents("trace-big", 1, 70_000),
      sdk_version: "marker-oversized-beacon",
    });
    expect(Buffer.byteLength(body)).toBeGreaterThan(64 * 1024);

    const r = await beacon(body);

    expect(r.statusCode).toBe(413);
    expect(r.json().error.code).toBe("YAVIO-2111");
    expect(parsedWith(parse, "marker-oversized-beacon")).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("accepts a 60,000-byte beacon with a valid body token", async () => {
    await build({ rateLimiter: new RateLimiter(), trustProxy: [PROXY] });
    const trace = "trace-full-beacon";
    const events = widgetEvents(trace, 200);
    const base = JSON.stringify({ token: widgetToken(trace), events, sdk_version: "x" });
    // Pad the last event's metadata up to the React SDK's chunk size.
    events[199] = {
      ...events[199],
      metadata: { pad: "y".repeat(60_000 - Buffer.byteLength(base) - 22) },
    } as (typeof events)[number];
    const body = JSON.stringify({ token: widgetToken(trace), events, sdk_version: "x" });
    expect(Buffer.byteLength(body)).toBeGreaterThan(59_900);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(60_000);

    const r = await beacon(body, "203.0.113.10");

    expect(r.statusCode).toBe(200);
    expect(r.json().accepted).toBe(200);
  });

  it("refuses a text/plain request with an empty or blank Authorization header before reading its body", async () => {
    await build();
    const parse = vi.spyOn(JSON, "parse");
    const body = (marker: string) =>
      JSON.stringify({
        token: widgetToken("trace-empty-header"),
        events: widgetEvents("trace-empty-header", 1),
        sdk_version: marker,
      });
    const send = (authorization: string, marker: string) =>
      app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "content-type": "text/plain;charset=UTF-8", authorization },
        payload: body(marker),
      });

    const empty = await send("", "marker-empty-header");
    expect(empty.statusCode).toBe(401);
    expect(empty.json().error.code).toBe("YAVIO-2000");

    const blank = await send("   ", "marker-blank-header");
    expect(blank.statusCode).toBe(401);
    expect(blank.json().error.code).toBe("YAVIO-2006");

    expect(parsedWith(parse, "marker-empty-header")).toBe(0);
    expect(parsedWith(parse, "marker-blank-header")).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses a header-less JSON request before reading its body", async () => {
    await build();
    const parse = vi.spyOn(JSON, "parse");
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        token: widgetToken("trace-json"),
        events: widgetEvents("trace-json", 1),
        sdk_version: "marker-headerless-json",
      }),
    });

    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("YAVIO-2000");
    expect(parsedWith(parse, "marker-headerless-json")).toBe(0);
  });

  it("with TRUST_PROXY, refuses concurrent header-less requests beyond the burst before parsing them", async () => {
    await build({
      // The beacon bucket (sixth argument) is charged on arrival.
      rateLimiter: new RateLimiter(undefined, undefined, undefined, undefined, undefined, {
        burstCapacity: 3,
        ratePerSecond: 0.001,
      }),
      trustProxy: [PROXY],
    });
    const parse = vi.spyOn(JSON, "parse");
    const bodies = Array.from({ length: 8 }, (_, i) =>
      JSON.stringify({
        token: "eyJ.not-a-valid.token",
        events: widgetEvents(`trace-${i}`, 1),
        sdk_version: `marker-concurrent-${i}`,
      }),
    );

    const responses = await Promise.all(bodies.map((b) => beacon(b, "203.0.113.20")));
    const statuses = responses.map((r) => r.statusCode);

    expect(statuses.filter((s) => s === 401)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    expect(parsedWith(parse, "marker-concurrent-")).toBe(3);
  });

  it("with TRUST_PROXY, refunds beacons that authenticate, so a client's normal beacons are never refused", async () => {
    await build({
      rateLimiter: new RateLimiter(undefined, { burstCapacity: 2, ratePerSecond: 0.001 }),
      trustProxy: [PROXY],
    });
    const trace = "trace-refund";
    for (let i = 0; i < 10; i++) {
      const body = JSON.stringify({ token: widgetToken(trace), events: widgetEvents(trace, 5) });
      expect((await beacon(body, "203.0.113.30")).statusCode).toBe(200);
    }
    // A bad token is charged and not refunded: two use the burst up.
    const bad = JSON.stringify({ token: "eyJ.bad.token", events: widgetEvents(trace, 1) });
    expect((await beacon(bad, "203.0.113.30")).statusCode).toBe(401);
    expect((await beacon(bad, "203.0.113.30")).statusCode).toBe(401);
    expect((await beacon(bad, "203.0.113.30")).statusCode).toBe(429);
    // Another client behind the same proxy has its own bucket.
    const good = JSON.stringify({ token: widgetToken(trace), events: widgetEvents(trace, 1) });
    expect((await beacon(good, "203.0.113.31")).statusCode).toBe(200);
  });

  it("without TRUST_PROXY, does not charge beacons on arrival: clients sharing the proxy's address are not refused together", async () => {
    await build({
      rateLimiter: new RateLimiter(undefined, { burstCapacity: 3, ratePerSecond: 0.001 }),
    });
    const trace = "trace-shared";
    const bodies = Array.from({ length: 8 }, () =>
      JSON.stringify({ token: widgetToken(trace), events: widgetEvents(trace, 1) }),
    );

    // Every request arrives from one address (the proxy's, untrusted).
    const responses = await Promise.all(bodies.map((b) => beacon(b)));

    expect(responses.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
  });

  it("answers a JSON body over 600,000 bytes with 413 before parsing it", async () => {
    await build();
    const parse = vi.spyOn(JSON, "parse");
    const payload = JSON.stringify({
      events: [{ pad: "z".repeat(600_100) }],
      sdk_version: "marker-big-json",
    });

    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      payload,
    });

    expect(r.statusCode).toBe(413);
    expect(r.json().error.code).toBe("YAVIO-2111");
    expect(parsedWith(parse, "marker-big-json")).toBe(0);
  });

  it("keeps the 500 KB batch limit for JSON bodies between 500 KB and 600,000 bytes", async () => {
    await build();
    const events = Array.from({ length: 11 }, () => ({
      ...widgetEvents("trace-1", 1)[0],
      source: "server",
      metadata: { pad: "w".repeat(48_000) },
    }));
    const payload = JSON.stringify({ events });
    expect(Buffer.byteLength(payload)).toBeGreaterThan(512_000);
    expect(Buffer.byteLength(payload)).toBeLessThan(600_000);

    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      payload,
    });

    expect(r.statusCode).toBe(413);
    expect(r.json().error).toMatchObject({
      code: "YAVIO-2111",
      message: "Batch exceeds 500KB limit",
    });
  });
});
