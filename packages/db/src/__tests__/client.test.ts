import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSql = { query: vi.fn() };
const mockDrizzleDb = { select: vi.fn() };

vi.mock("postgres", () => ({
  default: vi.fn(() => mockSql),
}));

vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: vi.fn(() => mockDrizzleDb),
}));

const { default: postgres } = await import("postgres");
const { drizzle } = await import("drizzle-orm/postgres-js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createDb", () => {
  it("calls postgres with the provided URL", async () => {
    const { createDb } = await import("../client.js");
    createDb("postgres://localhost:5432/test");
    expect(postgres).toHaveBeenCalledWith("postgres://localhost:5432/test");
  });

  it("passes the sql client and schema to drizzle", async () => {
    const { createDb } = await import("../client.js");
    createDb("postgres://localhost:5432/test");
    expect(drizzle).toHaveBeenCalledWith(mockSql, { schema: expect.any(Object) });
  });

  it("returns the drizzle database instance", async () => {
    const { createDb } = await import("../client.js");
    const db = createDb("postgres://localhost:5432/test");
    expect(db).toBe(mockDrizzleDb);
  });
});
