import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apiKeys, projects, users, workspaceMembers, workspaces } from "../schema.js";
import { disconnect, getServiceDb, runMigrations, truncateAll } from "./helpers/pg.js";

describe("PostgreSQL seed data", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("inserts user → workspace → project → API key without constraint violations", async () => {
    const { db } = getServiceDb();

    const [user] = await db
      .insert(users)
      .values({ email: "test@example.com", name: "Test User" })
      .returning();
    expect(user.id).toBeDefined();
    expect(user.email).toBe("test@example.com");

    const [workspace] = await db
      .insert(workspaces)
      .values({ name: "Test Workspace", slug: "test-ws", ownerId: user.id })
      .returning();
    expect(workspace.id).toBeDefined();
    expect(workspace.slug).toBe("test-ws");

    await db
      .insert(workspaceMembers)
      .values({ workspaceId: workspace.id, userId: user.id, role: "owner" });

    const [project] = await db
      .insert(projects)
      .values({
        workspaceId: workspace.id,
        name: "My Project",
        slug: "my-project",
      })
      .returning();
    expect(project.id).toBeDefined();

    const [apiKey] = await db
      .insert(apiKeys)
      .values({
        projectId: project.id,
        workspaceId: workspace.id,
        keyHash: "sha256-test-hash",
        keyPrefix: "yv_test_",
      })
      .returning();
    expect(apiKey.id).toBeDefined();
    expect(apiKey.keyPrefix).toBe("yv_test_");

    // Verify the chain is queryable
    const foundProjects = await db
      .select()
      .from(projects)
      .where(eq(projects.workspaceId, workspace.id));
    expect(foundProjects).toHaveLength(1);
  });
});
