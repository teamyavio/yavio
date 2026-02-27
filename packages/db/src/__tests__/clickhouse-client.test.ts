import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockClient = { query: vi.fn() };

vi.mock("@clickhouse/client", () => ({
  createClient: vi.fn(() => mockClient),
}));

const { createClient } = await import("@clickhouse/client");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createClickHouseClient", () => {
  const savedUrl = process.env.CLICKHOUSE_URL;

  afterEach(() => {
    if (savedUrl !== undefined) {
      process.env.CLICKHOUSE_URL = savedUrl;
    } else {
      // biome-ignore lint/performance/noDelete: env vars require delete to truly unset
      delete process.env.CLICKHOUSE_URL;
    }
  });

  it("creates a client with the explicitly provided URL", async () => {
    const { createClickHouseClient } = await import("../clickhouse-client.js");
    const client = createClickHouseClient("http://ch:8123");
    expect(createClient).toHaveBeenCalledWith({ url: "http://ch:8123" });
    expect(client).toBe(mockClient);
  });

  it("falls back to CLICKHOUSE_URL env var when no URL is provided", async () => {
    process.env.CLICKHOUSE_URL = "http://env-ch:8123";
    const { createClickHouseClient } = await import("../clickhouse-client.js");
    const client = createClickHouseClient();
    expect(createClient).toHaveBeenCalledWith({ url: "http://env-ch:8123" });
    expect(client).toBe(mockClient);
  });

  it("prefers explicit URL over env var", async () => {
    process.env.CLICKHOUSE_URL = "http://env-ch:8123";
    const { createClickHouseClient } = await import("../clickhouse-client.js");
    createClickHouseClient("http://explicit:8123");
    expect(createClient).toHaveBeenCalledWith({ url: "http://explicit:8123" });
  });

  it("throws YavioError when no URL is available", async () => {
    // biome-ignore lint/performance/noDelete: env vars require delete to truly unset
    delete process.env.CLICKHOUSE_URL;
    const { createClickHouseClient } = await import("../clickhouse-client.js");
    expect(() => createClickHouseClient()).toThrow("CLICKHOUSE_URL is not set");
  });

  it("throws with YAVIO error code for missing URL", async () => {
    // biome-ignore lint/performance/noDelete: env vars require delete to truly unset
    delete process.env.CLICKHOUSE_URL;
    const { createClickHouseClient } = await import("../clickhouse-client.js");
    try {
      createClickHouseClient();
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as Record<string, unknown>).code).toBe("YAVIO-7200");
    }
  });
});
