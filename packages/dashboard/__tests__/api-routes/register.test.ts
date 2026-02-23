import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ──────────────────────────────────────────────────────────
const mockInsert = vi.fn();
const mockInsertValues = vi.fn();
const mockInsertReturning = vi.fn();
const mockSelect = vi.fn();
const mockSelectFrom = vi.fn();
const mockSelectWhere = vi.fn();
const mockSelectLimit = vi.fn();
const mockTx = {
  insert: vi.fn(),
  select: vi.fn(),
};

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({
    select: mockSelect,
    insert: mockInsert,
    transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<void>) => {
      const txInsert = vi.fn();
      const txValues = vi.fn();
      const txReturning = vi.fn();

      txInsert.mockReturnValue({ values: txValues });
      txValues.mockReturnValue({ returning: txReturning });

      // First call: insert user → return user
      // Second call: insert workspace → return workspace
      // Third call: insert membership → no returning
      let callCount = 0;
      txReturning.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return [{ id: "user-id-123" }];
        if (callCount === 2) return [{ id: "ws-id-456" }];
        return [];
      });
      txValues.mockImplementation((vals: Record<string, unknown>) => {
        // membership insert has no returning()
        if (vals.role) return Promise.resolve();
        return { returning: txReturning };
      });

      const tx = { insert: txInsert };
      await fn(tx as unknown as typeof mockTx);
    }),
  })),
}));

vi.mock("@/lib/auth/password", () => ({
  hashPassword: vi.fn(async () => "hashed-password"),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
}));

vi.mock("@yavio/db/schema", () => ({
  users: { id: "id", email: "email" },
  workspaces: { id: "id" },
  workspaceMembers: {},
  projects: {},
}));

vi.mock("@yavio/shared/error-codes", () => ({
  ErrorCode: {
    DASHBOARD: {
      VALIDATION_FAILED: "YAVIO-3002",
      EMAIL_ALREADY_REGISTERED: "YAVIO-3003",
    },
  },
}));

import { POST } from "../../app/api/auth/register/route";

// ── helpers ────────────────────────────────────────────────────────
function makeRequest(body: unknown) {
  return new Request("http://localhost:3000/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = {
  name: "Test User",
  email: "test@example.com",
  password: "securepassword123",
  confirmPassword: "securepassword123",
};

// ── tests ──────────────────────────────────────────────────────────
describe("POST /api/auth/register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockReturnValue({ limit: mockSelectLimit });
    mockSelectLimit.mockResolvedValue([]); // no existing user
  });

  it("returns 201 on successful registration", async () => {
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.message).toBe("Account created");
  });

  it("returns 400 on invalid input (missing name)", async () => {
    const res = await POST(
      makeRequest({ email: "t@t.com", password: "12345678", confirmPassword: "12345678" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("YAVIO-3002");
  });

  it("returns 400 when passwords do not match", async () => {
    const res = await POST(
      makeRequest({
        name: "Test",
        email: "t@t.com",
        password: "password123",
        confirmPassword: "differentpassword",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when password is too short", async () => {
    const res = await POST(
      makeRequest({
        name: "Test",
        email: "t@t.com",
        password: "short",
        confirmPassword: "short",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when email is invalid", async () => {
    const res = await POST(
      makeRequest({
        name: "Test",
        email: "not-an-email",
        password: "password123",
        confirmPassword: "password123",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 when email already registered", async () => {
    mockSelectLimit.mockResolvedValue([{ id: "existing-user" }]);

    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("YAVIO-3003");
  });
});
