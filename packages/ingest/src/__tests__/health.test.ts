import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../index.js";

function mockDb(shouldFail = false) {
  return {
    execute: shouldFail
      ? async () => {
          throw new Error("connection refused");
        }
      : async () => [{ "?column?": 1 }],
  } as unknown as Database;
}

function mockClickHouse(shouldFail = false) {
  return {
    ping: shouldFail ? async () => ({ success: false }) : async () => ({ success: true }),
  } as unknown as ClickHouseClient;
}

describe("GET /health", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("returns ok when both databases are healthy", async () => {
    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(),
      jwtSecret: "test-secret",
      logger: false,
    });

    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.status).toBe("ok");
    expect(body.postgres).toBe("up");
    expect(body.clickhouse).toBe("up");
  });

  it("returns 503 degraded when postgres is down", async () => {
    app = await createApp({
      db: mockDb(true),
      clickhouse: mockClickHouse(),
      jwtSecret: "test-secret",
      logger: false,
    });

    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(503);

    const body = response.json();
    expect(body.status).toBe("degraded");
    expect(body.postgres).toBe("down");
    expect(body.clickhouse).toBe("up");
  });

  it("returns 503 degraded when clickhouse is down", async () => {
    app = await createApp({
      db: mockDb(),
      clickhouse: mockClickHouse(true),
      jwtSecret: "test-secret",
      logger: false,
    });

    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(503);

    const body = response.json();
    expect(body.status).toBe("degraded");
    expect(body.postgres).toBe("up");
    expect(body.clickhouse).toBe("down");
  });

  it("returns 503 degraded when both databases are down", async () => {
    app = await createApp({
      db: mockDb(true),
      clickhouse: mockClickHouse(true),
      jwtSecret: "test-secret",
      logger: false,
    });

    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(503);

    const body = response.json();
    expect(body.status).toBe("degraded");
    expect(body.postgres).toBe("down");
    expect(body.clickhouse).toBe("down");
  });
});
