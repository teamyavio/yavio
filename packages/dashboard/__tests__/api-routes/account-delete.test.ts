import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ──────────────────────────────────────────────────────────
const mockSelect = vi.fn();
const mockSelectFrom = vi.fn();
const mockSelectWhere = vi.fn();
const mockSelectLimit = vi.fn();
const mockDelete = vi.fn();
const mockDeleteWhere = vi.fn();

vi.mock("@/lib/auth/get-session", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth/password", () => ({
  verifyPassword: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({
    select: mockSelect,
    delete: mockDelete,
  })),
}));

// Deleting the account and queueing its ClickHouse erasure is one transaction
// in lib/erasure/requests (#91 part 2), tested against Postgres there.
const mockDeleteAccountWithErasure = vi.fn();
const mockKickErasure = vi.fn();
vi.mock("@/lib/erasure/requests", () => ({
  deleteAccountWithErasure: (...args: unknown[]) => mockDeleteAccountWithErasure(...args),
}));
vi.mock("@/lib/erasure", () => ({
  kickErasure: () => mockKickErasure(),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
}));

vi.mock("@yavio/db/schema", () => ({
  users: { id: "id", passwordHash: "passwordHash", email: "email" },
  workspaces: { id: "id", ownerId: "ownerId" },
}));

vi.mock("@yavio/shared/error-codes", () => ({
  ErrorCode: {
    DASHBOARD: {
      SESSION_EXPIRED: "YAVIO-3000",
      ACCOUNT_DELETION_REQUIRES_PASSWORD: "YAVIO-3700",
      INVALID_PASSWORD: "YAVIO-3701",
    },
  },
}));

import { DELETE } from "../../app/api/auth/account/route";
import { getServerSession } from "../../lib/auth/get-session";
import { verifyPassword } from "../../lib/auth/password";

const mockGetSession = getServerSession as Mock;
const mockVerifyPassword = verifyPassword as Mock;

// ── helpers ────────────────────────────────────────────────────────
function makeRequest(body: unknown) {
  return new Request("http://localhost:3000/api/auth/account", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── tests ──────────────────────────────────────────────────────────
describe("DELETE /api/auth/account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDelete.mockReturnValue({ where: mockDeleteWhere });
    mockDeleteWhere.mockResolvedValue(undefined);
  });

  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await DELETE(makeRequest({ password: "test" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("YAVIO-3000");
  });

  it("returns 400 when password is missing", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-1", email: "t@t.com", name: null });
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockReturnValue({
      limit: vi.fn().mockResolvedValue([{ passwordHash: "hash123", email: "t@t.com" }]),
    });
    const res = await DELETE(makeRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("YAVIO-3700");
  });

  it("returns 400 when OAuth user provides no email confirmation", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-1", email: "t@t.com", name: null });

    // User found but no passwordHash (OAuth)
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockReturnValue({
      limit: vi.fn().mockResolvedValue([{ passwordHash: null, email: "t@t.com" }]),
    });

    const res = await DELETE(makeRequest({ password: "test123" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("YAVIO-3700");
  });

  it("returns 200 when OAuth user confirms with email", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-1", email: "t@t.com", name: null });

    let callIdx = 0;
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) {
        return { limit: vi.fn().mockResolvedValue([{ passwordHash: null, email: "t@t.com" }]) };
      }
      // owned workspaces
      return Promise.resolve([]);
    });

    const res = await DELETE(makeRequest({ confirmEmail: "t@t.com" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("Account deleted");
    expect(mockDeleteAccountWithErasure).toHaveBeenCalledWith(expect.anything(), "u-1");
  });

  it("returns 400 when password is incorrect", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-1", email: "t@t.com", name: null });
    mockVerifyPassword.mockResolvedValue(false);

    let callIdx = 0;
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) {
        return {
          limit: vi.fn().mockResolvedValue([{ passwordHash: "hash123", email: "t@t.com" }]),
        };
      }
      return Promise.resolve([]);
    });

    const res = await DELETE(makeRequest({ password: "wrong" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("YAVIO-3701");
  });

  it("returns 200 on successful deletion", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-1", email: "t@t.com", name: null });
    mockVerifyPassword.mockResolvedValue(true);

    let callIdx = 0;
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) {
        return {
          limit: vi.fn().mockResolvedValue([{ passwordHash: "hash123", email: "t@t.com" }]),
        };
      }
      // owned workspaces
      return Promise.resolve([{ id: "ws-1" }]);
    });

    const res = await DELETE(makeRequest({ password: "correct" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("Account deleted");
    expect(mockDeleteAccountWithErasure).toHaveBeenCalledWith(expect.anything(), "u-1");
    expect(mockKickErasure).toHaveBeenCalledOnce();
  });

  it("does not delete or queue anything when the password is wrong", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-1", email: "t@t.com", name: null });
    mockVerifyPassword.mockResolvedValue(false);
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockImplementation(() => ({
      limit: vi.fn().mockResolvedValue([{ passwordHash: "hash123", email: "t@t.com" }]),
    }));

    const res = await DELETE(makeRequest({ password: "wrong" }));
    expect(res.status).toBe(400);
    expect(mockDeleteAccountWithErasure).not.toHaveBeenCalled();
    expect(mockKickErasure).not.toHaveBeenCalled();
  });
});
