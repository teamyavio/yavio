import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ──────────────────────────────────────────────────────────
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({
    select: mockSelect,
    insert: mockInsert,
  })),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ type: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ type: "and", args })),
  gt: vi.fn((...args: unknown[]) => ({ type: "gt", args })),
}));

vi.mock("@yavio/db/schema", () => ({
  loginAttempts: { email: "email", attemptedAt: "attemptedAt", ipAddress: "ipAddress" },
}));

import { checkLockout, recordFailedAttempt } from "../lib/auth/account-lockout";

// ── helpers ────────────────────────────────────────────────────────
function mockAttemptRows(count: number) {
  const rows = Array.from({ length: count }, (_, i) => ({
    email: "user@test.com",
    attemptedAt: new Date(),
    ipAddress: `1.2.3.${i}`,
  }));
  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockWhere });
  mockWhere.mockResolvedValue(rows);
}

// ── tests ──────────────────────────────────────────────────────────
describe("checkLockout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns not locked when no attempts exist", async () => {
    mockAttemptRows(0);
    const result = await checkLockout("user@test.com");
    expect(result).toEqual({ locked: false, attempts: 0 });
  });

  it("returns not locked when attempts are below first threshold (< 10)", async () => {
    mockAttemptRows(9);
    const result = await checkLockout("user@test.com");
    expect(result).toEqual({ locked: false, attempts: 9 });
  });

  // ── tier 1: 10 attempts → 5 minute lockout ──────────────────────
  it("locks for 5 minutes at exactly 10 attempts", async () => {
    mockAttemptRows(10);
    const result = await checkLockout("user@test.com");
    expect(result).toEqual({ locked: true, lockMinutes: 5, attempts: 10 });
  });

  it("locks for 5 minutes between 10 and 24 attempts", async () => {
    mockAttemptRows(15);
    const result = await checkLockout("user@test.com");
    expect(result).toEqual({ locked: true, lockMinutes: 5, attempts: 15 });
  });

  it("locks for 5 minutes at 24 attempts (just below tier 2)", async () => {
    mockAttemptRows(24);
    const result = await checkLockout("user@test.com");
    expect(result).toEqual({ locked: true, lockMinutes: 5, attempts: 24 });
  });

  // ── tier 2: 25 attempts → 15 minute lockout ─────────────────────
  it("locks for 15 minutes at exactly 25 attempts", async () => {
    mockAttemptRows(25);
    const result = await checkLockout("user@test.com");
    expect(result).toEqual({ locked: true, lockMinutes: 15, attempts: 25 });
  });

  it("locks for 15 minutes between 25 and 49 attempts", async () => {
    mockAttemptRows(35);
    const result = await checkLockout("user@test.com");
    expect(result).toEqual({ locked: true, lockMinutes: 15, attempts: 35 });
  });

  it("locks for 15 minutes at 49 attempts (just below tier 3)", async () => {
    mockAttemptRows(49);
    const result = await checkLockout("user@test.com");
    expect(result).toEqual({ locked: true, lockMinutes: 15, attempts: 49 });
  });

  // ── tier 3: 50 attempts → 60 minute lockout ─────────────────────
  it("locks for 60 minutes at exactly 50 attempts", async () => {
    mockAttemptRows(50);
    const result = await checkLockout("user@test.com");
    expect(result).toEqual({ locked: true, lockMinutes: 60, attempts: 50 });
  });

  it("locks for 60 minutes above 50 attempts", async () => {
    mockAttemptRows(100);
    const result = await checkLockout("user@test.com");
    expect(result).toEqual({ locked: true, lockMinutes: 60, attempts: 100 });
  });

  // ── highest threshold wins ───────────────────────────────────────
  it("returns the highest matching threshold (sorted desc)", async () => {
    // With 50+ attempts, the 60-minute lockout should take precedence
    mockAttemptRows(75);
    const result = await checkLockout("user@test.com");
    expect(result.lockMinutes).toBe(60);
  });
});

describe("recordFailedAttempt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts a record with email and IP", async () => {
    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockResolvedValue(undefined);

    await recordFailedAttempt("user@test.com", "192.168.1.1");

    expect(mockInsert).toHaveBeenCalled();
    expect(mockValues).toHaveBeenCalledWith({
      email: "user@test.com",
      ipAddress: "192.168.1.1",
    });
  });
});
