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

vi.mock("@/lib/clickhouse", () => ({
  getClickHouseClient: vi.fn(() => ({
    command: vi.fn(),
  })),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
}));

vi.mock("@yavio/db/schema", () => ({
  users: { id: "id", passwordHash: "passwordHash" },
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
    const res = await DELETE(makeRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("YAVIO-3700");
  });

  it("returns 400 when user has no password hash (OAuth-only)", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-1", email: "t@t.com", name: null });

    // User found but no passwordHash
    let callIdx = 0;
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) {
        return { limit: vi.fn().mockResolvedValue([{ passwordHash: null }]) };
      }
      return Promise.resolve([]);
    });

    const res = await DELETE(makeRequest({ password: "test123" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("YAVIO-3701");
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
        return { limit: vi.fn().mockResolvedValue([{ passwordHash: "hash123" }]) };
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
        return { limit: vi.fn().mockResolvedValue([{ passwordHash: "hash123" }]) };
      }
      // owned workspaces
      return Promise.resolve([{ id: "ws-1" }]);
    });

    const res = await DELETE(makeRequest({ password: "correct" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("Account deleted");
    expect(mockDelete).toHaveBeenCalled();
  });
});
