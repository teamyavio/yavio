import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ──────────────────────────────────────────────────────────
const mockSelect = vi.fn();
const mockSelectFrom = vi.fn();
const mockSelectWhere = vi.fn();
const mockSelectLimit = vi.fn();
const mockTxUpdate = vi.fn();
const mockTxUpdateSet = vi.fn();
const mockTxUpdateSetWhere = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({
    select: mockSelect,
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        update: mockTxUpdate,
      };
      mockTxUpdate.mockReturnValue({ set: mockTxUpdateSet });
      mockTxUpdateSet.mockReturnValue({ where: mockTxUpdateSetWhere });
      mockTxUpdateSetWhere.mockResolvedValue(undefined);
      await fn(tx);
    }),
  })),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  gt: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock("@yavio/db/schema", () => ({
  users: { id: "id", emailVerified: "emailVerified", updatedAt: "updatedAt" },
  verificationTokens: {
    id: "id",
    userId: "userId",
    tokenHash: "tokenHash",
    type: "type",
    usedAt: "usedAt",
    expiresAt: "expiresAt",
  },
}));

vi.mock("@yavio/shared/error-codes", () => ({
  ErrorCode: {
    DASHBOARD: {
      VALIDATION_FAILED: "YAVIO-3002",
      INVALID_EMAIL_VERIFICATION_TOKEN: "YAVIO-3004",
    },
  },
}));

import { POST } from "../../app/api/auth/verify-email/route";

// ── helpers ────────────────────────────────────────────────────────
function makeRequest(token: string | null) {
  const url = token
    ? `http://localhost:3000/api/auth/verify-email?token=${token}`
    : "http://localhost:3000/api/auth/verify-email";
  return new Request(url, { method: "POST" });
}

// ── tests ──────────────────────────────────────────────────────────
describe("POST /api/auth/verify-email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockReturnValue({ limit: mockSelectLimit });
  });

  it("returns 400 when token is missing", async () => {
    const res = await POST(makeRequest(null));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("YAVIO-3002");
  });

  it("returns 400 when token is invalid or expired", async () => {
    mockSelectLimit.mockResolvedValue([]); // no matching token
    const res = await POST(makeRequest("invalid-token"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("YAVIO-3004");
  });

  it("returns 200 on successful verification", async () => {
    mockSelectLimit.mockResolvedValue([{ id: "token-1", userId: "user-1" }]);

    const res = await POST(makeRequest("valid-token"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("Email verified successfully");
  });

  it("updates user and marks token as used in transaction", async () => {
    mockSelectLimit.mockResolvedValue([{ id: "token-1", userId: "user-1" }]);

    await POST(makeRequest("valid-token"));

    // Transaction should have been called with update operations
    expect(mockTxUpdate).toHaveBeenCalled();
    expect(mockTxUpdateSet).toHaveBeenCalled();
  });
});
