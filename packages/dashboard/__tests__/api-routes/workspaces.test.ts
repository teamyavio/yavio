import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ──────────────────────────────────────────────────────────
const mockSelect = vi.fn();
const mockSelectFrom = vi.fn();
const mockSelectWhere = vi.fn();
const mockSelectLimit = vi.fn();
const mockInsert = vi.fn();

vi.mock("@/lib/auth/get-session", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({
    select: mockSelect,
    insert: mockInsert,
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txInsert = vi.fn();
      const txValues = vi.fn();
      const txReturning = vi.fn();
      txInsert.mockReturnValue({ values: txValues });
      txValues.mockReturnValue({ returning: txReturning });
      txReturning.mockResolvedValue([
        { id: "ws-new", name: "New WS", slug: "new-ws", ownerId: "u-1", plan: "free" },
      ]);
      const tx = { insert: txInsert };
      return fn(tx);
    }),
  })),
}));

vi.mock("@/lib/workspace/slugify", () => ({
  slugify: vi.fn((name: string) => name.toLowerCase().replace(/\s+/g, "-")),
}));

vi.mock("@yavio/db/rls", () => ({
  withRLS: vi.fn(async (_db: unknown, _userId: string, fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => [
              { id: "ws-1", name: "Workspace 1", slug: "workspace-1", role: "owner" },
            ]),
          })),
        })),
      })),
    };
    return fn(tx);
  }),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
}));

vi.mock("@yavio/db/schema", () => ({
  workspaces: {
    id: "id",
    name: "name",
    slug: "slug",
    plan: "plan",
    ownerId: "ownerId",
    createdAt: "createdAt",
  },
  workspaceMembers: { workspaceId: "workspaceId", userId: "userId", role: "role" },
}));

vi.mock("@yavio/shared/error-codes", () => ({
  ErrorCode: {
    DASHBOARD: {
      SESSION_EXPIRED: "YAVIO-3000",
      VALIDATION_FAILED: "YAVIO-3002",
      WORKSPACE_SLUG_EXISTS: "YAVIO-3150",
    },
  },
}));

import { GET, POST } from "../../app/api/workspaces/route";
import { getServerSession } from "../../lib/auth/get-session";

const mockGetSession = getServerSession as Mock;

// ── helpers ────────────────────────────────────────────────────────
function makeRequest(body?: unknown) {
  if (body) {
    return new Request("http://localhost:3000/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  return new Request("http://localhost:3000/api/workspaces");
}

// ── tests ──────────────────────────────────────────────────────────
describe("GET /api/workspaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns workspaces for authenticated user", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-1", email: "t@t.com", name: null });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspaces).toBeDefined();
    expect(body.workspaces).toHaveLength(1);
  });
});

describe("POST /api/workspaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockReturnValue({ limit: mockSelectLimit });
    mockSelectLimit.mockResolvedValue([]); // no slug collision
  });

  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await POST(makeRequest({ name: "Test Workspace" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid input (name too short)", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-1", email: "t@t.com", name: null });
    const res = await POST(makeRequest({ name: "X" }));
    expect(res.status).toBe(400);
  });

  it("returns 409 when slug already exists", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-1", email: "t@t.com", name: null });
    mockSelectLimit.mockResolvedValue([{ id: "existing-ws" }]);

    const res = await POST(makeRequest({ name: "Test Workspace" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("YAVIO-3150");
  });

  it("returns 201 on successful creation", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-1", email: "t@t.com", name: null });
    const res = await POST(makeRequest({ name: "Test Workspace" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.workspace).toBeDefined();
  });
});
