import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ──────────────────────────────────────────────────────────
// Mock @/lib/auth before get-session to prevent next-auth ESM resolution
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/auth/get-session", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth/workspace-access", () => ({
  checkWorkspaceAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@yavio/shared/error-codes", () => ({
  ErrorCode: {
    DASHBOARD: {
      SESSION_EXPIRED: "YAVIO-3000",
      NOT_A_MEMBER: "YAVIO-3102",
      INSUFFICIENT_ROLE: "YAVIO-3100",
    },
  },
}));

import { getServerSession } from "../lib/auth/get-session";
import { withRole } from "../lib/auth/require-role";
import { checkWorkspaceAccess } from "../lib/auth/workspace-access";

const mockGetSession = getServerSession as Mock;
const mockCheckAccess = checkWorkspaceAccess as Mock;

// ── helpers ────────────────────────────────────────────────────────
function makeRequest(): Request {
  return new Request("http://localhost/api/workspaces/ws-1");
}

function makeRouteContext(workspaceId = "ws-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

const noopHandler = vi.fn(async (_req: Request, ctx: unknown) => {
  return Response.json({ ok: true, ctx });
});

// ── tests ──────────────────────────────────────────────────────────
describe("withRole", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 401: no session ──────────────────────────────────────────────
  it("returns 401 when no session", async () => {
    mockGetSession.mockResolvedValue(null);

    const handler = withRole("viewer")(noopHandler);
    const res = await handler(makeRequest(), makeRouteContext());

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("YAVIO-3000");
    expect(noopHandler).not.toHaveBeenCalled();
  });

  // ── 403: not a member ────────────────────────────────────────────
  it("returns 403 when user is not a member of the workspace", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-1", email: "a@b.c", name: null });
    mockCheckAccess.mockResolvedValue(null);

    const handler = withRole("viewer")(noopHandler);
    const res = await handler(makeRequest(), makeRouteContext());

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("YAVIO-3102");
    expect(noopHandler).not.toHaveBeenCalled();
  });

  // ── 403: insufficient role ───────────────────────────────────────
  it("returns 403 when role is below minimum", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-1", email: "a@b.c", name: null });
    mockCheckAccess.mockResolvedValue({ role: "viewer", isOwner: false });

    const handler = withRole("admin")(noopHandler);
    const res = await handler(makeRequest(), makeRouteContext());

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("YAVIO-3100");
    expect(noopHandler).not.toHaveBeenCalled();
  });

  it("returns 403 when member tries to access admin route", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-1", email: "a@b.c", name: null });
    mockCheckAccess.mockResolvedValue({ role: "member", isOwner: false });

    const handler = withRole("admin")(noopHandler);
    const res = await handler(makeRequest(), makeRouteContext());

    expect(res.status).toBe(403);
  });

  // ── role hierarchy: each level can access its own and below ──────
  const hierarchyCases: Array<{
    userRole: string;
    minimumRole: string;
    allowed: boolean;
  }> = [
    { userRole: "owner", minimumRole: "owner", allowed: true },
    { userRole: "owner", minimumRole: "admin", allowed: true },
    { userRole: "owner", minimumRole: "member", allowed: true },
    { userRole: "owner", minimumRole: "viewer", allowed: true },
    { userRole: "admin", minimumRole: "owner", allowed: false },
    { userRole: "admin", minimumRole: "admin", allowed: true },
    { userRole: "admin", minimumRole: "member", allowed: true },
    { userRole: "admin", minimumRole: "viewer", allowed: true },
    { userRole: "member", minimumRole: "owner", allowed: false },
    { userRole: "member", minimumRole: "admin", allowed: false },
    { userRole: "member", minimumRole: "member", allowed: true },
    { userRole: "member", minimumRole: "viewer", allowed: true },
    { userRole: "viewer", minimumRole: "owner", allowed: false },
    { userRole: "viewer", minimumRole: "admin", allowed: false },
    { userRole: "viewer", minimumRole: "member", allowed: false },
    { userRole: "viewer", minimumRole: "viewer", allowed: true },
  ];

  for (const { userRole, minimumRole, allowed } of hierarchyCases) {
    it(`${userRole} ${allowed ? "can" : "cannot"} access ${minimumRole}-level route`, async () => {
      mockGetSession.mockResolvedValue({ userId: "u-1", email: "a@b.c", name: null });
      mockCheckAccess.mockResolvedValue({ role: userRole, isOwner: userRole === "owner" });

      const handler = withRole(minimumRole as "owner" | "admin" | "member" | "viewer")(noopHandler);
      const res = await handler(makeRequest(), makeRouteContext());

      if (allowed) {
        expect(res.status).toBe(200);
        expect(noopHandler).toHaveBeenCalled();
      } else {
        expect(res.status).toBe(403);
        expect(noopHandler).not.toHaveBeenCalled();
      }
    });
  }

  // ── AuthContext passed correctly ─────────────────────────────────
  it("passes correct AuthContext to the handler", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-42", email: "a@b.c", name: "Test" });
    mockCheckAccess.mockResolvedValue({ role: "admin", isOwner: false });

    const handler = withRole("viewer")(noopHandler);
    await handler(makeRequest(), makeRouteContext("ws-99"));

    expect(noopHandler).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: "u-42",
        workspaceId: "ws-99",
        role: "admin",
        isOwner: false,
      }),
    );
  });

  it("sets isOwner true when user owns the workspace", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-1", email: "a@b.c", name: null });
    mockCheckAccess.mockResolvedValue({ role: "owner", isOwner: true });

    const handler = withRole("viewer")(noopHandler);
    await handler(makeRequest(), makeRouteContext());

    expect(noopHandler).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ isOwner: true }),
    );
  });

  // ── workspace ID from route params ───────────────────────────────
  it("extracts workspaceId from route params", async () => {
    mockGetSession.mockResolvedValue({ userId: "u-1", email: "a@b.c", name: null });
    mockCheckAccess.mockResolvedValue({ role: "member", isOwner: false });

    const handler = withRole("viewer")(noopHandler);
    await handler(makeRequest(), makeRouteContext("workspace-abc"));

    expect(mockCheckAccess).toHaveBeenCalledWith("u-1", "workspace-abc");
  });
});
