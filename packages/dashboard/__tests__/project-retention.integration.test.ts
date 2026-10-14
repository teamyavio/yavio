import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type Database, createDb } from "@yavio/db/client";
import { projects, users, workspaceMembers, workspaces } from "@yavio/db/schema";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Per-project retention (#93): the project routes against a real Postgres,
// only the session and the membership lookup mocked. The range check in
// Postgres itself is tested in packages/db.

const pgUrl = process.env.DATABASE_URL;

let db: Database;
let role = "member";
let userId = "";

vi.mock("@/lib/auth/get-session", () => ({
  getServerSession: vi.fn(async () => ({ userId })),
}));
vi.mock("@/lib/auth/workspace-access", () => ({
  checkWorkspaceAccess: vi.fn(async () => ({ role })),
}));
vi.mock("@/lib/db", () => ({
  getDb: () => db,
}));

type ProjectRoute = typeof import("../app/api/workspaces/[workspaceId]/projects/[projectId]/route");
type ProjectsRoute = typeof import("../app/api/workspaces/[workspaceId]/projects/route");

describe.skipIf(!pgUrl)("project retention_months (#93)", () => {
  let project: ProjectRoute;
  let list: ProjectsRoute;
  let ws = "";
  let projectId = "";

  const patch = async (body: unknown): Promise<Response> => {
    const res = await project.PATCH(
      new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify(body) }),
      { params: Promise.resolve({ workspaceId: ws, projectId }) },
    );
    if (!res) throw new Error("PATCH returned no response");
    return res;
  };

  const stored = async () =>
    (await db.select().from(projects).where(eq(projects.id, projectId)))[0].retentionMonths;

  beforeAll(async () => {
    db = createDb(pgUrl as string);
    await migrate(db, { migrationsFolder: join(process.cwd(), "..", "db", "drizzle") });
    const [user] = await db
      .insert(users)
      .values({ email: `retention-${randomUUID()}@test.local`, name: "R" })
      .returning();
    userId = user.id;
    const [w] = await db
      .insert(workspaces)
      .values({ name: "Retention WS", slug: `ret-${randomUUID().slice(0, 8)}`, ownerId: user.id })
      .returning();
    ws = w.id;
    await db.insert(workspaceMembers).values({ workspaceId: ws, userId, role: "owner" });
    const [p] = await db
      .insert(projects)
      .values({ workspaceId: ws, name: "P", slug: "p" })
      .returning();
    projectId = p.id;
    project = await import("../app/api/workspaces/[workspaceId]/projects/[projectId]/route");
    list = await import("../app/api/workspaces/[workspaceId]/projects/route");
  });

  afterAll(async () => {
    if (ws) await db.delete(workspaces).where(eq(workspaces.id, ws));
    if (userId) await db.delete(users).where(eq(users.id, userId));
    await db?.$client.end();
  });

  beforeEach(() => {
    role = "member";
  });

  it("is 13 months for a new project, and the list shows it", async () => {
    expect(await stored()).toBe(13);
    const res = await list.GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ workspaceId: ws }),
    });
    const { projects: listed } = await res.json();
    expect(listed).toEqual([expect.objectContaining({ id: projectId, retentionMonths: 13 })]);
  });

  it("stores a shorter retention", async () => {
    const res = await patch({ retentionMonths: 6 });
    expect(res.status).toBe(200);
    expect((await res.json()).project.retentionMonths).toBe(6);
    expect(await stored()).toBe(6);
  });

  it("keeps the retention when only the name changes", async () => {
    const res = await patch({ name: "Renamed" });
    expect(res.status).toBe(200);
    expect(await stored()).toBe(6);
  });

  it.each([1, 14, 0, 6.5, "6"])("rejects %s with a 400 and stores nothing", async (months) => {
    const res = await patch({ retentionMonths: months });
    expect(res.status).toBe(400);
    expect(await stored()).toBe(6);
  });

  it("is not for viewers", async () => {
    role = "viewer";
    const res = await patch({ retentionMonths: 2 });
    expect(res.status).toBe(403);
    expect(await stored()).toBe(6);
  });
});
