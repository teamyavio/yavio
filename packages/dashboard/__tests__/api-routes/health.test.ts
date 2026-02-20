import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ──────────────────────────────────────────────────────────
const mockDbExecute = vi.fn();
const mockChQuery = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({
    execute: mockDbExecute,
  })),
}));

vi.mock("@/lib/clickhouse", () => ({
  getClickHouseClient: vi.fn(() => ({
    query: mockChQuery,
  })),
}));

import { GET } from "../../app/api/health/route";

// ── tests ──────────────────────────────────────────────────────────
describe("GET /api/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns healthy when both databases are up", async () => {
    mockDbExecute.mockResolvedValue(undefined);
    mockChQuery.mockResolvedValue(undefined);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("healthy");
    expect(body.checks.postgres).toBe("ok");
    expect(body.checks.clickhouse).toBe("ok");
  });

  it("returns degraded with 503 when Postgres is down", async () => {
    mockDbExecute.mockRejectedValue(new Error("connection refused"));
    mockChQuery.mockResolvedValue(undefined);

    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.postgres).toBe("error");
    expect(body.checks.clickhouse).toBe("ok");
  });

  it("returns degraded with 503 when ClickHouse is down", async () => {
    mockDbExecute.mockResolvedValue(undefined);
    mockChQuery.mockRejectedValue(new Error("timeout"));

    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.postgres).toBe("ok");
    expect(body.checks.clickhouse).toBe("error");
  });

  it("returns degraded with 503 when both databases are down", async () => {
    mockDbExecute.mockRejectedValue(new Error("pg down"));
    mockChQuery.mockRejectedValue(new Error("ch down"));

    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.postgres).toBe("error");
    expect(body.checks.clickhouse).toBe("error");
  });
});
