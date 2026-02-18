import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withRLS } from "../rls.js";
import { projects, users, workspaceMembers, workspaces } from "../schema.js";
import { disconnect, getAppDb, getServiceDb, runMigrations, truncateAll } from "./helpers/pg.js";

describe("PostgreSQL Row-Level Security", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("user can only see their own user row via withRLS", async () => {
    const { db: serviceDb } = getServiceDb();
    const { db: appDb } = getAppDb();

    const [alice] = await serviceDb
      .insert(users)
      .values({ email: "alice@test.com", name: "Alice" })
      .returning();
    await serviceDb.insert(users).values({ email: "bob@test.com", name: "Bob" }).returning();

    const aliceRows = await withRLS(appDb, alice.id, async (tx) => {
      return tx.select().from(users);
    });

    expect(aliceRows).toHaveLength(1);
    expect(aliceRows[0].email).toBe("alice@test.com");
  });

  it("user only sees workspaces they belong to", async () => {
    const { db: serviceDb } = getServiceDb();
    const { db: appDb } = getAppDb();

    const [alice] = await serviceDb
      .insert(users)
      .values({ email: "alice@test.com", name: "Alice" })
      .returning();
    const [bob] = await serviceDb
      .insert(users)
      .values({ email: "bob@test.com", name: "Bob" })
      .returning();

    const [wsAlice] = await serviceDb
      .insert(workspaces)
      .values({ name: "Alice WS", slug: "alice-ws", ownerId: alice.id })
      .returning();
    const [wsBob] = await serviceDb
      .insert(workspaces)
      .values({ name: "Bob WS", slug: "bob-ws", ownerId: bob.id })
      .returning();

    await serviceDb.insert(workspaceMembers).values([
      { workspaceId: wsAlice.id, userId: alice.id, role: "owner" },
      { workspaceId: wsBob.id, userId: bob.id, role: "owner" },
    ]);

    const aliceWorkspaces = await withRLS(appDb, alice.id, async (tx) => {
      return tx.select().from(workspaces);
    });
    expect(aliceWorkspaces).toHaveLength(1);
    expect(aliceWorkspaces[0].slug).toBe("alice-ws");
  });

  it("user cannot see projects in workspaces they don't belong to", async () => {
    const { db: serviceDb } = getServiceDb();
    const { db: appDb } = getAppDb();

    const [alice] = await serviceDb
      .insert(users)
      .values({ email: "alice@test.com", name: "Alice" })
      .returning();
    const [bob] = await serviceDb
      .insert(users)
      .values({ email: "bob@test.com", name: "Bob" })
      .returning();

    const [wsAlice] = await serviceDb
      .insert(workspaces)
      .values({ name: "Alice WS", slug: "alice-ws", ownerId: alice.id })
      .returning();
    const [wsBob] = await serviceDb
      .insert(workspaces)
      .values({ name: "Bob WS", slug: "bob-ws", ownerId: bob.id })
      .returning();

    await serviceDb.insert(workspaceMembers).values([
      { workspaceId: wsAlice.id, userId: alice.id, role: "owner" },
      { workspaceId: wsBob.id, userId: bob.id, role: "owner" },
    ]);

    await serviceDb
      .insert(projects)
      .values({ workspaceId: wsAlice.id, name: "Alice Proj", slug: "alice-proj" });
    await serviceDb
      .insert(projects)
      .values({ workspaceId: wsBob.id, name: "Bob Proj", slug: "bob-proj" });

    // Alice should only see her own project
    const aliceProjects = await withRLS(appDb, alice.id, async (tx) => {
      return tx.select().from(projects);
    });
    expect(aliceProjects).toHaveLength(1);
    expect(aliceProjects[0].name).toBe("Alice Proj");

    // Bob should only see his own project
    const bobProjects = await withRLS(appDb, bob.id, async (tx) => {
      return tx.select().from(projects);
    });
    expect(bobProjects).toHaveLength(1);
    expect(bobProjects[0].name).toBe("Bob Proj");
  });
});
