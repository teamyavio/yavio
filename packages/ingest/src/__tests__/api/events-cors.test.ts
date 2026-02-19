import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../index.js";
import type { ApiKeyResolver } from "../../lib/api-key-resolver.js";

function mockDb() {
  return { execute: async () => [{ "?column?": 1 }] } as unknown as Database;
}

function mockClickHouse() {
  return { ping: async () => ({ success: true }) } as unknown as ClickHouseClient;
}

function mockResolver() {
  return {
    resolve: async () => ({ projectId: "p1", workspaceId: "w1" }),
    clearCache: () => {},
  } as unknown as ApiKeyResolver;
}

describe("CORS", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  async function buildApp() {
    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      apiKeyResolver: mockResolver(),
      jwtSecret: "test-secret",
      logger: false,
    });
    return app;
  }

  it("responds to OPTIONS preflight with CORS headers", async () => {
    await buildApp();
    const r = await app.inject({
      method: "OPTIONS",
      url: "/v1/events",
      headers: {
        origin: "https://example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "Authorization,Content-Type",
      },
    });
    expect(r.statusCode).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe("https://example.com");
    expect(r.headers["access-control-allow-methods"]).toContain("POST");
    expect(r.headers["access-control-allow-headers"]).toContain("Authorization");
  });

  it("includes CORS headers on POST responses", async () => {
    await buildApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: {
        origin: "https://example.com",
        authorization: "Bearer yav_abc123def456abc123def456abc123de",
      },
      payload: {
        events: [
          {
            event_id: "00000000-0000-0000-0000-000000000000",
            event_type: "track",
            trace_id: "t",
            session_id: "s",
            timestamp: new Date().toISOString(),
            source: "server",
          },
        ],
      },
    });
    expect(r.headers["access-control-allow-origin"]).toBe("https://example.com");
  });

  it("includes CORS headers on health endpoint", async () => {
    await buildApp();
    const r = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://example.com" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["access-control-allow-origin"]).toBe("https://example.com");
  });
});
