import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../index.js";
import type { ApiKeyResolver } from "../lib/api-key-resolver.js";

// #92: request log lines carry method, route and status — no client IP, no
// query string, no Authorization header.

function lines(): { write(line: string): void; all: () => Array<Record<string, unknown>> } {
  const out: string[] = [];
  return {
    write: (line: string) => {
      out.push(line);
    },
    all: () => out.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe("request log (#92)", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  async function build(stream: { write(line: string): void }, trustProxy?: string[]) {
    return createApp({
      db: { execute: async () => [{ "?column?": 1 }] } as unknown as Database,
      clickhouse: { ping: async () => ({ success: true }) } as unknown as ClickHouseClient,
      apiKeyResolver: {
        resolve: async () => null,
        clearCache: () => {},
      } as unknown as ApiKeyResolver,
      jwtSecret: "test-secret",
      logStream: stream,
      trustProxy,
    });
  }

  it("logs method, route and status but no IP, query string or credential", async () => {
    const stream = lines();
    app = await build(stream, ["172.30.240.1"]);

    await app.inject({
      method: "POST",
      url: "/v1/events?token=secret-widget-token",
      remoteAddress: "172.30.240.1",
      headers: {
        authorization: "Bearer yav_secretsecretsecretsecretsecret12",
        "x-forwarded-for": "203.0.113.77",
      },
      payload: { events: [] },
    });

    const raw = JSON.stringify(stream.all());
    expect(raw).not.toContain("203.0.113.77");
    expect(raw).not.toContain("172.30.240.1");
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("remoteAddress");

    const incoming = stream.all().find((l) => l.msg === "incoming request");
    expect(incoming?.req).toEqual({ method: "POST", url: "/v1/events" });
    const completed = stream.all().find((l) => l.msg === "request completed");
    expect(completed?.res).toEqual({ statusCode: 401 });
  });

  it("logs the path without query string for unknown routes", async () => {
    const stream = lines();
    app = await build(stream);

    await app.inject({ method: "GET", url: "/.env?x=1", remoteAddress: "198.51.100.3" });

    const incoming = stream.all().find((l) => l.msg === "incoming request");
    expect(incoming?.req).toEqual({ method: "GET", url: "/.env" });
    expect(JSON.stringify(stream.all())).not.toContain("198.51.100.3");
  });
});
