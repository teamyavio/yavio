import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../index.js";
import type { ApiKeyResolver } from "../lib/api-key-resolver.js";
import type { BatchWriter } from "../lib/batch-writer.js";
import { jwtSign } from "../lib/jwt.js";
import { RateLimiter, type RateLimiterConfig } from "../lib/rate-limiter.js";
import { addressBucket, widgetUnits } from "../plugins/rate-limit.js";

// Widget-token requests are charged in units, max(events, ceil(body / 1 KiB)),
// to three buckets at once: the token's, the client address's (with
// TRUST_PROXY; IPv6 by /64) and the project's widget ceiling.

const JWT_SECRET = "widget-cost-secret";
const API_KEY = "yav_abc123def456abc123def456abc123de";
const PROJECT = "11111111-1111-1111-1111-111111111111";
const OTHER_PROJECT = "33333333-3333-3333-3333-333333333333";
const WORKSPACE = "22222222-2222-2222-2222-222222222222";
const PROXY = "172.30.240.1";

function widgetToken(traceId: string, projectId = PROJECT): string {
  const now = Math.floor(Date.now() / 1000);
  return jwtSign(
    { pid: projectId, wid: WORKSPACE, tid: traceId, sid: "ses-1", iat: now, exp: now + 900 },
    JWT_SECRET,
  );
}

/** Events shaped like the React SDK's auto-captured ones. */
function widgetEvents(traceId: string, n: number, padding = 0) {
  return Array.from({ length: n }, (_, i) => ({
    event_id: randomUUID(),
    event_type: "widget_click",
    event_name: "widget_click",
    trace_id: traceId,
    session_id: "ses_V1StGXR8_Z5jdHi6B-myT",
    timestamp: new Date().toISOString(),
    source: "widget",
    platform: "chatgpt",
    sdk_version: "0.5.5",
    click_count: 1,
    metadata: {
      target_tag: "button",
      target_text: `Book room ${i}`,
      ...(padding > 0 ? { pad: "x".repeat(padding) } : {}),
    },
  }));
}

describe("widgetUnits", () => {
  it("charges a widget's batches and beacon chunks by their events", () => {
    const batch = JSON.stringify({
      events: widgetEvents("tr_V1StGXR8_Z5jdHi6B-myT", 20),
      sdk_version: "0.5.5",
      sent_at: new Date().toISOString(),
    });
    const bytes = Buffer.byteLength(batch);
    expect(bytes).toBeLessThan(20 * 1024);
    expect(widgetUnits(20, bytes)).toBe(20);

    // A beacon chunk: up to 200 events in at most 60,000 bytes.
    expect(widgetUnits(200, 60_000)).toBe(200);
  });

  it("charges a body larger than its events by the KiB", () => {
    expect(widgetUnits(1, 100 * 1024)).toBe(100);
    expect(widgetUnits(20, 64 * 1024)).toBe(64);
    expect(widgetUnits(1, 1)).toBe(1);
    expect(widgetUnits(1, 0)).toBe(1);
  });
});

describe("addressBucket", () => {
  it("keys IPv4 by the address and IPv6 by its /64", () => {
    expect(addressBucket("203.0.113.5")).toBe("203.0.113.5");
    expect(addressBucket("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(addressBucket("2001:0db8:0001:0002:ffff::1")).toBe("2001:db8:1:2::/64");
    expect(addressBucket("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(addressBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressBucket("::1")).toBe("0:0:0:0::/64");
    expect(addressBucket("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(addressBucket("64:ff9b::203.0.113.5")).toBe("64:ff9b:0:0::/64");
    expect(addressBucket("::ffff:203.0.113.5")).toBe("203.0.113.5");
  });
});

describe("RateLimiter.consumeWidget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("charges all buckets or none", () => {
    const limiter = new RateLimiter(
      undefined,
      undefined,
      { burstCapacity: 100, ratePerSecond: 1 },
      { burstCapacity: 100, ratePerSecond: 1 },
      { burstCapacity: 10, ratePerSecond: 1 },
    );
    const keys = { token: "t", address: "a", project: "p" };
    const refused = limiter.consumeWidget(keys, 20);
    expect(refused).toMatchObject({ allowed: false, limit: "project" });
    // The token and address buckets were not charged for the refusal: after
    // these 10, the token still holds 90, which nine fresh projects use up.
    expect(limiter.consumeWidget(keys, 10).allowed).toBe(true);
    for (let i = 0; i < 9; i++) {
      expect(limiter.consumeWidget({ token: "t", project: `p${i}` }, 10).allowed).toBe(true);
    }
    expect(limiter.consumeWidget({ token: "t", project: "p9" }, 1)).toMatchObject({
      limit: "token",
    });
  });

  it("names the first bucket short and waits for the slowest", () => {
    const limiter = new RateLimiter(
      undefined,
      undefined,
      { burstCapacity: 5, ratePerSecond: 5 },
      { burstCapacity: 100, ratePerSecond: 100 },
      { burstCapacity: 5, ratePerSecond: 1 },
    );
    const refused = limiter.consumeWidget({ token: "t", address: "a", project: "p" }, 10);
    expect(refused).toMatchObject({ allowed: false, limit: "token", retryAfterMs: 5_000 });
  });

  it("uses no address bucket when none is given", () => {
    const limiter = new RateLimiter(undefined, undefined, undefined, { burstCapacity: 1 });
    expect(limiter.consumeWidget({ token: "t", project: "p" }, 50).allowed).toBe(true);
    expect(limiter.widgetAddressBucketCount).toBe(0);
  });

  it("reports a project's ceiling at most once a minute", () => {
    const limiter = new RateLimiter(undefined, undefined, undefined, undefined, {
      burstCapacity: 10,
      ratePerSecond: 0.001,
    });
    const keys = (t: string) => ({ token: t, project: "p" });
    expect(limiter.consumeWidget(keys("a"), 10).allowed).toBe(true);
    expect(limiter.consumeWidget(keys("b"), 5)).toMatchObject({ limit: "project", warn: true });
    expect(limiter.consumeWidget(keys("c"), 5)).toMatchObject({ limit: "project", warn: false });
    vi.advanceTimersByTime(60_000);
    expect(limiter.consumeWidget(keys("d"), 5)).toMatchObject({ limit: "project", warn: true });
  });

  it("has the documented defaults", () => {
    const limiter = new RateLimiter();
    expect(limiter.consumeWidget({ token: "t", address: "a", project: "p" }, 1_000).allowed).toBe(
      true,
    );
    // Token: burst 1,000.
    expect(limiter.consumeWidget({ token: "t", address: "a", project: "p" }, 1)).toMatchObject({
      limit: "token",
    });
    // Address: burst 2,000.
    expect(limiter.consumeWidget({ token: "t2", address: "a", project: "p" }, 1_000).allowed).toBe(
      true,
    );
    expect(limiter.consumeWidget({ token: "t3", address: "a", project: "p" }, 1)).toMatchObject({
      limit: "address",
    });
    // Project: burst 10,000.
    for (let i = 0; i < 8; i++) {
      const allowed = limiter.consumeWidget(
        { token: `p${i}`, address: `b${i}`, project: "p" },
        1_000,
      );
      expect(allowed.allowed).toBe(true);
    }
    expect(limiter.consumeWidget({ token: "p9", address: "b9", project: "p" }, 1)).toMatchObject({
      limit: "project",
    });
  });
});

describe("POST /v1/events — widget cost", () => {
  let app: FastifyInstance;
  let enqueue: ReturnType<typeof vi.fn>;
  let logLines: string[];

  afterEach(async () => {
    await app?.close();
  });

  async function build(rateLimiter: RateLimiter, trustProxy?: string[]) {
    enqueue = vi.fn().mockReturnValue(false);
    logLines = [];
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
      logStream: { write: (line: string) => void logLines.push(line) },
    });
  }

  const limiter = (
    token?: Partial<RateLimiterConfig>,
    address?: Partial<RateLimiterConfig>,
    project?: Partial<RateLimiterConfig>,
  ) => new RateLimiter(undefined, undefined, token, address, project);

  const send = (
    traceId: string,
    events: unknown[],
    opts: { client?: string; projectId?: string } = {},
  ) =>
    app.inject({
      method: "POST",
      url: "/v1/events",
      remoteAddress: opts.client ? PROXY : "198.51.100.50",
      headers: {
        authorization: `Bearer ${widgetToken(traceId, opts.projectId)}`,
        ...(opts.client ? { "x-forwarded-for": opts.client } : {}),
      },
      payload: { events },
    });

  it("charges a request with few events and a large body by the KiB", async () => {
    await build(limiter({ burstCapacity: 100, ratePerSecond: 0.001 }));

    // 2 events in about 120 KiB: 120 units, more than the token's 100.
    const r = await send("trace-big", widgetEvents("trace-big", 2, 60_000));
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toMatchObject({
      code: "YAVIO-2053",
      message: "Widget token rate limit exceeded",
    });
    // The same 2 events in a small body pass.
    expect((await send("trace-big", widgetEvents("trace-big", 2))).statusCode).toBe(200);
  });

  it("charges a widget request whose body fails to parse by the KiB read", async () => {
    await build(limiter({ burstCapacity: 60, ratePerSecond: 0.001 }));
    const token = widgetToken("trace-a");

    const malformed = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: `{"events": [${"1,".repeat(25_000)}`,
    });
    expect(malformed.statusCode).toBe(400);
    // About 49 units used: a 20-event batch no longer fits the token's 60.
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token}` },
      payload: { events: widgetEvents("trace-a", 20) },
    });
    expect(r.statusCode).toBe(429);
  });

  it("with TRUST_PROXY, charges one client address across its tokens", async () => {
    await build(limiter(undefined, { burstCapacity: 30, ratePerSecond: 0.001 }), [PROXY]);

    expect(
      (await send("trace-1", widgetEvents("trace-1", 20), { client: "203.0.113.7" })).statusCode,
    ).toBe(200);
    const refused = await send("trace-2", widgetEvents("trace-2", 20), { client: "203.0.113.7" });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.message).toBe("Widget rate limit exceeded for this address");
    // Another client, and another address in a different /64, are not affected.
    expect(
      (await send("trace-3", widgetEvents("trace-3", 20), { client: "203.0.113.8" })).statusCode,
    ).toBe(200);
    expect(
      (await send("trace-4", widgetEvents("trace-4", 20), { client: "2001:db8:1:2::1" }))
        .statusCode,
    ).toBe(200);
    // The same /64 is one bucket.
    expect(
      (await send("trace-5", widgetEvents("trace-5", 20), { client: "2001:db8:1:2::99" }))
        .statusCode,
    ).toBe(429);
  });

  it("without TRUST_PROXY, has no address bucket: clients behind one proxy are not refused together", async () => {
    await build(limiter(undefined, { burstCapacity: 30, ratePerSecond: 0.001 }));

    for (let i = 0; i < 5; i++) {
      expect((await send(`trace-${i}`, widgetEvents(`trace-${i}`, 20))).statusCode).toBe(200);
    }
  });

  it("caps a project's widgets together, separately from its API key, and logs it", async () => {
    await build(limiter(undefined, undefined, { burstCapacity: 50, ratePerSecond: 0.001 }));

    expect((await send("trace-1", widgetEvents("trace-1", 20))).statusCode).toBe(200);
    expect((await send("trace-2", widgetEvents("trace-2", 20))).statusCode).toBe(200);
    const refused = await send("trace-3", widgetEvents("trace-3", 20));
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error).toMatchObject({
      code: "YAVIO-2053",
      message: "Widget rate limit exceeded for this project",
    });
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    await send("trace-4", widgetEvents("trace-4", 20));
    const warnings = logLines.filter((l) =>
      l.includes("Widget rate limit for the project reached"),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(PROJECT);

    // Another project's widgets, and this project's API key, are unaffected.
    expect(
      (await send("trace-5", widgetEvents("trace-5", 20), { projectId: OTHER_PROJECT })).statusCode,
    ).toBe(200);
    const keyed = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: {
        events: widgetEvents("trace-6", 20).map((e) => ({
          ...e,
          source: "server",
          event_type: "track",
        })),
      },
    });
    expect(keyed.statusCode).toBe(200);
  });

  it("passes a widget's normal traffic with the default limits", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await build(new RateLimiter(), [PROXY]);
      // One user's widget, as the React SDK sends: fetch batches of 20 events
      // (JSON, token in the header) and a teardown beacon of 200 events in
      // 60,000 bytes (text/plain;charset=UTF-8, token in the body).
      for (let i = 0; i < 10; i++) {
        expect(
          (await send("trace-n", widgetEvents("trace-n", 20), { client: "203.0.113.9" }))
            .statusCode,
        ).toBe(200);
      }
      const token = widgetToken("trace-n");
      const events = Array.from({ length: 200 }, () => ({
        event_id: randomUUID(),
        event_type: "widget_click",
        trace_id: "trace-n",
        session_id: "ses_V1StGXR8_Z5jdHi6B-myT",
        timestamp: new Date().toISOString(),
        source: "widget",
        metadata: { pad: "" },
      }));
      const short = 60_000 - Buffer.byteLength(JSON.stringify({ token, events }));
      events.forEach((e, i) => {
        const pad = Math.floor(short / 200) + (i === 199 ? short % 200 : 0);
        e.metadata = { pad: "p".repeat(pad) };
      });
      const body = JSON.stringify({ token, events });
      expect(Buffer.byteLength(body)).toBe(60_000);
      const beacon = await app.inject({
        method: "POST",
        url: "/v1/events",
        remoteAddress: PROXY,
        headers: { "content-type": "text/plain;charset=UTF-8", "x-forwarded-for": "203.0.113.9" },
        payload: body,
      });
      expect(beacon.statusCode).toBe(200);
      expect(beacon.json().accepted).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
