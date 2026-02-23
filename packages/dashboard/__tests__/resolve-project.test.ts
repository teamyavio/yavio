import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbResult = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: () => mockDbResult(),
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("@yavio/db/schema", () => ({
  workspaces: { id: "id", name: "name", slug: "slug" },
  projects: { id: "id", name: "name", slug: "slug", workspaceId: "workspace_id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a, b) => [a, b]),
  and: vi.fn((...args: unknown[]) => args),
}));

import { resolveProject } from "@/lib/analytics/resolve-project";

describe("resolveProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns resolved data when workspace and project exist", async () => {
    mockDbResult.mockResolvedValue([
      {
        workspaceId: "ws_1",
        workspaceName: "Acme",
        workspaceSlug: "acme",
        projectId: "proj_1",
        projectName: "My App",
        projectSlug: "my-app",
      },
    ]);

    const result = await resolveProject("acme", "my-app");
    expect(result).toEqual({
      workspaceId: "ws_1",
      workspaceName: "Acme",
      workspaceSlug: "acme",
      projectId: "proj_1",
      projectName: "My App",
      projectSlug: "my-app",
    });
  });

  it("returns null when workspace or project not found", async () => {
    mockDbResult.mockResolvedValue([]);

    const result = await resolveProject("nonexistent", "nope");
    expect(result).toBeNull();
  });
});
