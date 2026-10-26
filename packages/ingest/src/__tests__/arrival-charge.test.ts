import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../index.js";
import type { ApiKeyResolver } from "../lib/api-key-resolver.js";
import type { BatchWriter } from "../lib/batch-writer.js";
import { jwtSign } from "../lib/jwt.js";
import { RateLimiter, type RateLimiterConfig } from "../lib/rate-limiter.js";
import { reservationUnits } from "../plugins/charge.js";
import { JSON_BODY_LIMIT } from "../plugins/events.js";

// A request authenticated by its header is charged before its body is read:
// an API key one event, a widget token its declared body size (or, without a
// Content-Length, the JSON body limit) in units. A refusal is a 429 with the
// body unread. The handler then settles the charge to the real one. Address
// buckets are keyed by addressBucket (IPv6 by /64); header-less beacons are
// charged on arrival to their own bucket.

const JWT_SECRET = "arrival-charge-secret";
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

function events(traceId: string, n: number, source = "widget", padding = 0) {
  return Array.from({ length: n }, () => ({
    event_id: randomUUID(),
    event_type: source === "widget" ? "widget_click" : "track",
    trace_id: traceId,
    session_id: "ses-1",
    timestamp: new Date().toISOString(),
    source,
    ...(padding > 0 ? { metadata: { pad: "x".repeat(padding) } } : {}),
  }));
}

/** JSON.parse calls whose input contains `marker`. */
function parsedWith(spy: { mock: { calls: unknown[][] } }, marker: string): number {
  return spy.mock.calls.filter(
    (call) => typeof call[0] === "string" && (call[0] as string).includes(marker),
  ).length;
}

describe("charging before the body is read", { timeout: 20_000 }, () => {
  let app: FastifyInstance;
  let enqueue: ReturnType<typeof vi.fn>;

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
  });

  async function build(rateLimiter: RateLimiter, trustProxy?: string[]) {
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
      trustProxy,
      logger: false,
    });
    await app.ready();
  }

  const token = (config: Partial<RateLimiterConfig>) =>
    new RateLimiter(undefined, undefined, config);

  /** A JSON batch with a widget token in the header; a stream payload has no Content-Length. */
  const widgetPost = (
    traceId: string,
    body: unknown,
    opts: { chunked?: boolean; marker?: string } = {},
  ) => {
    const text = JSON.stringify({ ...(body as object), sdk_version: opts.marker ?? "x" });
    return app.inject({
      method: "POST",
      url: "/v1/events",
      headers: {
        authorization: `Bearer ${widgetToken(traceId)}`,
        "content-type": "application/json",
      },
      payload: opts.chunked ? Readable.from([Buffer.from(text)]) : text,
    });
  };

  it("answers a widget token whose bucket is short 429 without reading the body", async () => {
    await build(token({ burstCapacity: 30, ratePerSecond: 0.001 }));
    const parse = vi.spyOn(JSON, "parse");
    expect((await widgetPost("trace-a", { events: events("trace-a", 25) })).statusCode).toBe(200);

    // About 50 KiB declared: 50 units, more than the 5 left.
    const r = await widgetPost(
      "trace-a",
      { events: events("trace-a", 1, "widget", 50_000) },
      { marker: "marker-short-bucket" },
    );

    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe("YAVIO-2053");
    expect(parsedWith(parse, "marker-short-bucket")).toBe(0);
  });

  it("charges a body without a Content-Length the JSON body limit up front, unread when that does not fit", async () => {
    await build(token({ burstCapacity: 400, ratePerSecond: 0.001 }));
    const parse = vi.spyOn(JSON, "parse");
    expect(Math.ceil(JSON_BODY_LIMIT / 1024)).toBeGreaterThan(400);

    const r = await widgetPost(
      "trace-b",
      { events: events("trace-b", 1) },
      { chunked: true, marker: "marker-chunked" },
    );

    expect(r.statusCode).toBe(429);
    expect(parsedWith(parse, "marker-chunked")).toBe(0);
  });

  it("refunds what the up-front charge held above the real one", async () => {
    await build(token({ burstCapacity: 600, ratePerSecond: 0.001 }));

    // Without a Content-Length: 586 units up front, 20 really (20 events).
    const chunked = await widgetPost(
      "trace-c",
      { events: events("trace-c", 20) },
      { chunked: true },
    );
    expect(chunked.statusCode).toBe(200);
    // 580 left after the refund: a batch of 580 events (charged by its events) fits.
    expect((await widgetPost("trace-c", { events: events("trace-c", 580) })).statusCode).toBe(200);
    expect((await widgetPost("trace-c", { events: events("trace-c", 1) })).statusCode).toBe(429);
  });

  it("charges a request once: the up-front units are part of its real charge", async () => {
    await build(token({ burstCapacity: 100, ratePerSecond: 0.001 }));

    // 2 events in about 59 KiB: charged its KiB once, not up front and again.
    const big = { events: events("trace-d", 2, "widget", 29_500) };
    const kib = Math.ceil(Buffer.byteLength(JSON.stringify({ ...big, sdk_version: "x" })) / 1024);
    expect(kib).toBeGreaterThan(50);
    expect((await widgetPost("trace-d", big)).statusCode).toBe(200);
    // What is left fits exactly that many events, then nothing.
    const left = 100 - kib;
    expect((await widgetPost("trace-d", { events: events("trace-d", left) })).statusCode).toBe(200);
    expect((await widgetPost("trace-d", { events: events("trace-d", 1) })).statusCode).toBe(429);
  });

  it("keeps the up-front charge of a request refused after its body was read", async () => {
    await build(token({ burstCapacity: 30, ratePerSecond: 0.001 }));

    expect((await widgetPost("trace-e", { events: events("trace-e", 20) })).statusCode).toBe(200);
    // 10 left; 20 small events: a few units up front, the rest refused.
    const refused = await widgetPost("trace-e", { events: events("trace-e", 20) });
    expect(refused.statusCode).toBe(429);
    // What the refused body cost stays charged: a batch of 10 no longer fits.
    expect((await widgetPost("trace-e", { events: events("trace-e", 10) })).statusCode).toBe(429);
  });

  it("answers an API key whose bucket is empty 429 without reading the body", async () => {
    await build(new RateLimiter({ burstCapacity: 1, ratePerSecond: 0.001 }));
    const parse = vi.spyOn(JSON, "parse");
    const post = (marker: string) =>
      app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
        payload: JSON.stringify({ events: events("trace-k", 1, "server"), sdk_version: marker }),
      });

    expect((await post("marker-first")).statusCode).toBe(200);
    const r = await post("marker-empty-key-bucket");

    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe("YAVIO-2050");
    expect(parsedWith(parse, "marker-empty-key-bucket")).toBe(0);
  });

  it("charges an API key its events, one of them up front", async () => {
    await build(new RateLimiter({ burstCapacity: 10, ratePerSecond: 0.001 }));
    const post = (n: number) =>
      app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { events: events("trace-k", n, "server") },
      });

    expect((await post(6)).statusCode).toBe(200);
    expect((await post(4)).statusCode).toBe(200);
    expect((await post(1)).statusCode).toBe(429);
  });
});

describe("reservationUnits", () => {
  const limits = { json: JSON_BODY_LIMIT, text: 64 * 1024 };
  const request = (headers: Record<string, string>) =>
    ({ headers }) as unknown as Parameters<typeof reservationUnits>[0];

  it("is the declared size in KiB, at least one", () => {
    expect(reservationUnits(request({ "content-length": "7000" }), limits)).toBe(7);
    expect(reservationUnits(request({ "content-length": "0" }), limits)).toBe(1);
  });

  it("is the type's body limit without a Content-Length", () => {
    expect(reservationUnits(request({ "content-type": "application/json" }), limits)).toBe(
      Math.ceil(JSON_BODY_LIMIT / 1024),
    );
    expect(reservationUnits(request({ "content-type": "text/plain;charset=UTF-8" }), limits)).toBe(
      64,
    );
  });

  it("is one unit for a declared size over the limit, which is refused unread", () => {
    expect(
      reservationUnits(request({ "content-length": String(JSON_BODY_LIMIT + 1) }), limits),
    ).toBe(1);
  });
});

describe("address buckets — keyed by /64 for IPv6", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  async function build(rateLimiter: RateLimiter) {
    app = await createApp({
      db: { execute: async () => [{ "?column?": 1 }] } as unknown as Database,
      clickhouse: { ping: async () => ({ success: true }) } as unknown as ClickHouseClient,
      apiKeyResolver: {
        resolve: async () => null,
        clearCache: () => {},
      } as unknown as ApiKeyResolver,
      jwtSecret: JWT_SECRET,
      rateLimiter,
      logger: false,
    });
  }

  it("shares the credential-less bucket across a /64, not across /64s", async () => {
    await build(new RateLimiter(undefined, { burstCapacity: 1, ratePerSecond: 0.001 }));
    const probe = (remoteAddress: string) =>
      app.inject({ method: "GET", url: "/probe", remoteAddress });

    expect((await probe("2001:db8:1:2::1")).statusCode).toBe(404);
    expect((await probe("2001:db8:1:2:ffff:ffff:ffff:ffff")).statusCode).toBe(429);
    expect((await probe("2001:db8:1:3::1")).statusCode).toBe(404);
    // IPv4 stays per address.
    expect((await probe("198.51.100.1")).statusCode).toBe(404);
    expect((await probe("198.51.100.2")).statusCode).toBe(404);
  });

  it("shares the auth-failure bucket across a /64", async () => {
    await build(new RateLimiter(undefined, { burstCapacity: 2, ratePerSecond: 0.001 }));
    const badKey = (remoteAddress: string) =>
      app.inject({
        method: "POST",
        url: "/v1/events",
        remoteAddress,
        headers: { authorization: "Bearer yav_00000000000000000000000000000000" },
        payload: { events: [] },
      });

    expect((await badKey("2001:db8:5:6::1")).statusCode).toBe(401);
    expect((await badKey("2001:db8:5:6::2")).statusCode).toBe(401);
    expect((await badKey("2001:db8:5:6::3")).statusCode).toBe(429);
    expect((await badKey("2001:db8:5:7::1")).statusCode).toBe(401);
  });
});

describe(
  "beacon bucket — header-less requests on arrival, with TRUST_PROXY",
  { timeout: 20_000 },
  () => {
    let app: FastifyInstance;

    afterEach(async () => {
      vi.restoreAllMocks();
      vi.useRealTimers();
      await app?.close();
    });

    async function build(rateLimiter: RateLimiter) {
      // Only Date is faked: the buckets do not refill while the test runs,
      // and fastify keeps its real timers.
      vi.useFakeTimers({ toFake: ["Date"] });
      app = await createApp({
        db: { execute: async () => [{ "?column?": 1 }] } as unknown as Database,
        clickhouse: { ping: async () => ({ success: true }) } as unknown as ClickHouseClient,
        apiKeyResolver: {
          resolve: async () => null,
          clearCache: () => {},
        } as unknown as ApiKeyResolver,
        jwtSecret: JWT_SECRET,
        batchWriter: { enqueue: () => false } as unknown as BatchWriter,
        rateLimiter,
        trustProxy: [PROXY],
        logger: false,
      });
      await app.ready();
    }

    const beacon = (body: string, client: string) =>
      app.inject({
        method: "POST",
        url: "/v1/events",
        remoteAddress: PROXY,
        headers: { "content-type": "text/plain;charset=UTF-8", "x-forwarded-for": client },
        payload: body,
      });

    it("passes 50 simultaneous valid beacons from one address with the default limits", async () => {
      await build(new RateLimiter());
      const bodies = Array.from({ length: 50 }, (_, i) =>
        JSON.stringify({ token: widgetToken(`trace-${i}`), events: events(`trace-${i}`, 4) }),
      );

      const responses = await Promise.all(bodies.map((b) => beacon(b, "203.0.113.60")));

      expect(responses.map((r) => r.statusCode)).toEqual(Array(50).fill(200));
    });

    it("gives a beacon's arrival charge back only when it is accepted, so a token with an empty widget bucket reads 100 beacons, not more", async () => {
      await build(
        new RateLimiter(undefined, undefined, { burstCapacity: 1, ratePerSecond: 0.001 }),
      );
      const parse = vi.spyOn(JSON, "parse");
      const send = (marker: string, n: number) =>
        beacon(
          JSON.stringify({
            token: widgetToken("trace-empty"),
            events: events("trace-empty", n),
            sdk_version: marker,
          }),
          "203.0.113.63",
        );

      // The token's one unit goes to the first beacon, which is accepted.
      expect((await send("marker-first-beacon", 1)).statusCode).toBe(200);
      const statuses: number[] = [];
      for (let i = 0; i < 130; i++) {
        statuses.push((await send(`marker-refused-beacon-${i}`, 1)).statusCode);
      }

      expect(statuses.every((s) => s === 429)).toBe(true);
      // Refused at the token's bucket after being read: 100 of them, the
      // beacon bucket's burst; the rest are refused on arrival, unread.
      expect(parsedWith(parse, "marker-refused-beacon-")).toBe(100);
    });

    it("refuses header-less requests beyond its burst unread, and keeps the auth-failure bucket for failures", async () => {
      await build(new RateLimiter());
      const parse = vi.spyOn(JSON, "parse");
      const garbage = Array.from({ length: 130 }, (_, i) =>
        JSON.stringify({ token: "eyJ.not.valid", events: [], sdk_version: `marker-garbage-${i}` }),
      );

      const responses = await Promise.all(garbage.map((b) => beacon(b, "203.0.113.61")));
      const statuses = responses.map((r) => r.statusCode);

      // The beacon bucket's burst of 100 is read; the rest is refused unread.
      expect(statuses.filter((s) => s === 401)).toHaveLength(100);
      expect(statuses.filter((s) => s === 429)).toHaveLength(30);
      expect(parsedWith(parse, "marker-garbage-")).toBe(100);
      // Those failures used up the address's auth-failure budget: even a valid
      // beacon from it is refused now, while another address is not.
      const valid = JSON.stringify({ token: widgetToken("trace-v"), events: events("trace-v", 1) });
      expect((await beacon(valid, "203.0.113.61")).statusCode).toBe(429);
      expect((await beacon(valid, "203.0.113.62")).statusCode).toBe(200);
    });
  },
);
