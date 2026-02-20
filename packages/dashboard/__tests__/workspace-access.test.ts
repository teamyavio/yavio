import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ──────────────────────────────────────────────────────────
const mockSelect = vi.fn();
const mockSelectFrom = vi.fn();
const mockSelectInnerJoin = vi.fn();
const mockSelectWhere = vi.fn();
const mockSelectLimit = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({
    select: mockSelect,
  })),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
}));

vi.mock("@yavio/db/schema", () => ({
  workspaceMembers: { workspaceId: "workspaceId", userId: "userId", role: "role" },
  workspaces: { id: "id", ownerId: "ownerId" },
}));

import { checkWorkspaceAccess } from "../lib/auth/workspace-access";

// ── tests ──────────────────────────────────────────────────────────
describe("checkWorkspaceAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ innerJoin: mockSelectInnerJoin });
    mockSelectInnerJoin.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockReturnValue({ limit: mockSelectLimit });
  });

  it("returns null when user is not a member", async () => {
    mockSelectLimit.mockResolvedValue([]);
    const result = await checkWorkspaceAccess("u-1", "ws-1");
    expect(result).toBeNull();
  });

  it("returns role and isOwner=true when user is owner", async () => {
    mockSelectLimit.mockResolvedValue([{ role: "owner", ownerId: "u-1" }]);
    const result = await checkWorkspaceAccess("u-1", "ws-1");
    expect(result).toEqual({ role: "owner", isOwner: true });
  });

  it("returns role and isOwner=false when user is admin but not owner", async () => {
    mockSelectLimit.mockResolvedValue([{ role: "admin", ownerId: "u-other" }]);
    const result = await checkWorkspaceAccess("u-1", "ws-1");
    expect(result).toEqual({ role: "admin", isOwner: false });
  });

  it("returns role and isOwner=false for viewer", async () => {
    mockSelectLimit.mockResolvedValue([{ role: "viewer", ownerId: "u-other" }]);
    const result = await checkWorkspaceAccess("u-1", "ws-1");
    expect(result).toEqual({ role: "viewer", isOwner: false });
  });

  it("returns role and isOwner=false for member", async () => {
    mockSelectLimit.mockResolvedValue([{ role: "member", ownerId: "u-other" }]);
    const result = await checkWorkspaceAccess("u-1", "ws-1");
    expect(result).toEqual({ role: "member", isOwner: false });
  });
});
