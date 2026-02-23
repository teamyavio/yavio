import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ──────────────────────────────────────────────────────────
const mockSelect = vi.fn();
const mockSelectFrom = vi.fn();
const mockSelectWhere = vi.fn();
const mockUpdate = vi.fn();
const mockUpdateSet = vi.fn();
const mockUpdateWhere = vi.fn();
const mockUpdateReturning = vi.fn();

vi.mock("@/lib/auth/get-session", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth/password", () => ({
  verifyPassword: vi.fn(),
  hashPassword: vi.fn(async () => "new-hash-123"),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({
    select: mockSelect,
    update: mockUpdate,
  })),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
}));

vi.mock("@yavio/db/schema", () => ({
  users: {
    id: "id",
    name: "name",
    email: "email",
    passwordHash: "passwordHash",
    updatedAt: "updatedAt",
  },
  workspaces: { id: "id", ownerId: "ownerId" },
}));

vi.mock("@yavio/shared/error-codes", () => ({
  ErrorCode: {
    DASHBOARD: {
      SESSION_EXPIRED: "YAVIO-3000",
      VALIDATION_FAILED: "YAVIO-3050",
      INVALID_PASSWORD: "YAVIO-3701",
    },
  },
}));

import { PATCH } from "../../app/api/auth/account/route";
import { getServerSession } from "../../lib/auth/get-session";
import { verifyPassword } from "../../lib/auth/password";

const mockGetSession = getServerSession as Mock;
const mockVerifyPassword = verifyPassword as Mock;

// ── helpers ────────────────────────────────────────────────────────
function makeRequest(body: unknown) {
  return new Request("http://localhost:3000/api/auth/account", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── tests ──────────────────────────────────────────────────────────
describe("PATCH /api/auth/account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockReturnValue({ returning: mockUpdateReturning });
    mockUpdateReturning.mockResolvedValue([{ id: "u-1", name: "Updated", email: "t@t.com" }]);
  });

  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await PATCH(makeRequest({ name: "Test" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("YAVIO-3000");
  });

  it("updates name successfully", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-1", email: "t@t.com", name: null });

    const res = await PATCH(makeRequest({ name: "New Name" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toBeDefined();
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("returns 400 for invalid name (empty)", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-1", email: "t@t.com", name: null });

    const res = await PATCH(makeRequest({ name: "" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("YAVIO-3050");
  });

  it("changes password successfully", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-1", email: "t@t.com", name: null });
    mockVerifyPassword.mockResolvedValue(true);

    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockReturnValue({
      limit: vi.fn().mockResolvedValue([{ passwordHash: "old-hash" }]),
    });

    const res = await PATCH(
      makeRequest({
        currentPassword: "oldpass123",
        newPassword: "newpass123",
        confirmNewPassword: "newpass123",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("Password updated");
  });

  it("returns 400 when current password is incorrect", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-1", email: "t@t.com", name: null });
    mockVerifyPassword.mockResolvedValue(false);

    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockReturnValue({
      limit: vi.fn().mockResolvedValue([{ passwordHash: "old-hash" }]),
    });

    const res = await PATCH(
      makeRequest({
        currentPassword: "wrongpass",
        newPassword: "newpass123",
        confirmNewPassword: "newpass123",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("YAVIO-3701");
  });

  it("returns 400 when passwords do not match", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-1", email: "t@t.com", name: null });

    const res = await PATCH(
      makeRequest({
        currentPassword: "oldpass123",
        newPassword: "newpass123",
        confirmNewPassword: "different456",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("YAVIO-3050");
  });

  it("returns 400 for OAuth user trying to change password", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-1", email: "t@t.com", name: null });

    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockReturnValue({
      limit: vi.fn().mockResolvedValue([{ passwordHash: null }]),
    });

    const res = await PATCH(
      makeRequest({
        currentPassword: "anything",
        newPassword: "newpass123",
        confirmNewPassword: "newpass123",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("YAVIO-3701");
  });
});
