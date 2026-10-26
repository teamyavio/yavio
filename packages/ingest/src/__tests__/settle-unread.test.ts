import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../index.js";
import type { ApiKeyResolver } from "../lib/api-key-resolver.js";
import type { BatchWriter } from "../lib/batch-writer.js";
import { jwtSign } from "../lib/jwt.js";
import { RateLimiter } from "../lib/rate-limiter.js";
import { widgetTokenBucket } from "../plugins/rate-limit.js";

// A widget token's arrival charge is settled even when the handler never
// runs: to the KiB a parser read, to one unit for an unsupported type, and
// to the KiB received when the client goes away or the request times out.
// The token bucket holds 600 units; a body without a Content-Length is
// charged 586 on arrival, one declaring 600,000 bytes the same.

const JWT_SECRET = "settle-unread-secret";
const PROJECT = "11111111-1111-1111-1111-111111111111";
const WORKSPACE = "22222222-2222-2222-2222-222222222222";
const TRACE = "trace-settle";

const token = (() => {
  const now = Math.floor(Date.now() / 1000);
  return jwtSign(
    { pid: PROJECT, wid: WORKSPACE, tid: TRACE, sid: "ses-1", iat: now, exp: now + 3600 },
    JWT_SECRET,
  );
})();

const keys = {
  token: widgetTokenBucket({
    projectId: PROJECT,
    workspaceId: WORKSPACE,
    source: "jwt",
    traceId: TRACE,
    sessionId: "ses-1",
  }),
  project: PROJECT,
};

describe(
  "settling a widget token's arrival charge when the handler never runs",
  { timeout: 20_000 },
  () => {
    let app: FastifyInstance;
    let limiter: RateLimiter;

    afterEach(async () => {
      await app?.close();
    });

    async function build(requestTimeoutMs?: number) {
      limiter = new RateLimiter(undefined, undefined, { burstCapacity: 600, ratePerSecond: 0.001 });
      app = await createApp({
        db: { execute: async () => [{ "?column?": 1 }] } as unknown as Database,
        clickhouse: { ping: async () => ({ success: true }) } as unknown as ClickHouseClient,
        apiKeyResolver: {
          resolve: async () => null,
          clearCache: () => {},
        } as unknown as ApiKeyResolver,
        jwtSecret: JWT_SECRET,
        batchWriter: { enqueue: () => false } as unknown as BatchWriter,
        rateLimiter: limiter,
        requestTimeoutMs,
        logger: false,
      });
    }

    /** Whether the token bucket holds `units`; uses them up when it does. */
    const holds = (units: number) => limiter.consumeWidget(keys, units).allowed;

    const chunked = (body: string, contentType = "application/json") =>
      app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${token}`, "content-type": contentType },
        payload: Readable.from([Buffer.from(body)]),
      });

    it("settles a body that fails to parse to the KiB read", async () => {
      await build();
      const r = await chunked(`{"events":[${"1,".repeat(25_000)}`);
      expect(r.statusCode).toBe(400);
      // 586 on arrival, about 49 really: about 551 left.
      expect(holds(550)).toBe(true);
    });

    it("settles a body nested too deep to the KiB read", async () => {
      await build();
      const r = await chunked(
        `{"pad":"${"x".repeat(30_000)}","events":${"[".repeat(100)}${"]".repeat(100)}}`,
      );
      expect(r.statusCode).toBe(400);
      expect(r.json().error.message).toBe("Body nests deeper than 64 levels");
      expect(holds(560)).toBe(true);
    });

    it("settles an unsupported content type (415) to one unit", async () => {
      await build();
      const r = await chunked("<events/>", "application/xml");
      expect(r.statusCode).toBe(415);
      expect(holds(599)).toBe(true);
    });

    /** Opens a connection, sends the headers and `sent` bytes of a declared 600,000-byte body. */
    async function partialBody(sent: number) {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const { port } = app.server.address() as AddressInfo;
      const socket = connect(port, "127.0.0.1");
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      const received: Buffer[] = [];
      socket.on("data", (chunk) => received.push(chunk));
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      socket.on("error", () => {});
      socket.write(
        [
          "POST /v1/events HTTP/1.1",
          "Host: 127.0.0.1",
          `Authorization: Bearer ${token}`,
          "Content-Type: application/json",
          "Content-Length: 600000",
          "",
          "",
        ].join("\r\n"),
      );
      // The headers first, then the body, so the arrival count sits between them.
      await new Promise((resolve) => setTimeout(resolve, 100));
      socket.write(`{"events":[${"0,".repeat(Math.floor((sent - 11) / 2))}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { socket, closed, response: () => Buffer.concat(received).toString() };
    }

    it("settles a request whose client goes away mid-body to the KiB received", async () => {
      await build();
      const { socket, closed } = await partialBody(20_000);
      // Charged 586 on arrival.
      expect(holds(15)).toBe(false);
      socket.destroy();
      await closed;
      // About 20 KiB received: about 580 left.
      await vi.waitFor(() => expect(holds(575)).toBe(true), { timeout: 5_000, interval: 50 });
    });

    it("answers a request whose body does not arrive in time 408, and settles it to the KiB received", async () => {
      await build(1_000);
      const { closed, response } = await partialBody(20_000);
      await closed;
      expect(response()).toMatch(/^HTTP\/1\.1 408/);
      await vi.waitFor(() => expect(holds(575)).toBe(true), { timeout: 5_000, interval: 50 });
    });
  },
);
