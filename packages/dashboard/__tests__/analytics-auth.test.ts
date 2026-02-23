import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetServerSession = vi.fn();
const mockCheckWorkspaceAccess = vi.fn();
const mockDbSelect = vi.fn();

vi.mock("@/lib/auth/get-session", () => ({
  getServerSession: () => mockGetServerSession(),
}));

vi.mock("@/lib/auth/workspace-access", () => ({
  checkWorkspaceAccess: (...args: unknown[]) => mockCheckWorkspaceAccess(...args),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => mockDbSelect(),
        }),
      }),
    }),
  }),
}));

vi.mock("@yavio/db/schema", () => ({
  projects: { id: "id", workspaceId: "workspace_id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a, b) => [a, b]),
  and: vi.fn((...args: unknown[]) => args),
}));

import { withAnalyticsAuth } from "@/lib/analytics/auth";

describe("withAnalyticsAuth", () => {
  const mockHandler = vi.fn(() => new Response("ok"));
  const makeRequest = () => new Request("http://localhost/api/analytics/proj_1/overview");
  const routeContext = { params: Promise.resolve({ projectId: "proj_1" }) };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when no session", async () => {
    mockGetServerSession.mockResolvedValue(null);

    const handler = withAnalyticsAuth("viewer")(mockHandler);
    const res = await handler(makeRequest(), routeContext);
    expect(res.status).toBe(401);
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it("returns 404 when project not found", async () => {
    mockGetServerSession.mockResolvedValue({ userId: "user_1" });
    mockDbSelect.mockResolvedValue([]);

    const handler = withAnalyticsAuth("viewer")(mockHandler);
    const res = await handler(makeRequest(), routeContext);
    expect(res.status).toBe(404);
  });

  it("returns 403 when user is not a member", async () => {
    mockGetServerSession.mockResolvedValue({ userId: "user_1" });
    mockDbSelect.mockResolvedValue([{ workspaceId: "ws_1" }]);
    mockCheckWorkspaceAccess.mockResolvedValue(null);

    const handler = withAnalyticsAuth("viewer")(mockHandler);
    const res = await handler(makeRequest(), routeContext);
    expect(res.status).toBe(403);
  });

  it("returns 403 when role is insufficient", async () => {
    mockGetServerSession.mockResolvedValue({ userId: "user_1" });
    mockDbSelect.mockResolvedValue([{ workspaceId: "ws_1" }]);
    mockCheckWorkspaceAccess.mockResolvedValue({ role: "viewer", isOwner: false });

    const handler = withAnalyticsAuth("admin")(mockHandler);
    const res = await handler(makeRequest(), routeContext);
    expect(res.status).toBe(403);
  });

  it("calls handler with auth context when authorized", async () => {
    mockGetServerSession.mockResolvedValue({ userId: "user_1" });
    mockDbSelect.mockResolvedValue([{ workspaceId: "ws_1" }]);
    mockCheckWorkspaceAccess.mockResolvedValue({ role: "admin", isOwner: false });

    const handler = withAnalyticsAuth("viewer")(mockHandler);
    await handler(makeRequest(), routeContext);

    expect(mockHandler).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        userId: "user_1",
        workspaceId: "ws_1",
        projectId: "proj_1",
        role: "admin",
      }),
    );
  });
});
