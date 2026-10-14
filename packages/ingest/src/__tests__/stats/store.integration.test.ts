import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Database, createDb } from "@yavio/db/client";
import { projects, statsJobRuns, users, workspaces } from "@yavio/db/schema";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgStatsJobStore } from "../../stats/store.js";

// The statistics job's Postgres side (#85): advisory lock, run state, and the
// project list it uses to skip deleted projects. Against a real Postgres: the
// test-ingest CI job has one; locally, docker-compose.test.yml.

const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set; the test-ingest job must provide Postgres");
}

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../../../db/drizzle");

describe.skipIf(!url)("PgStatsJobStore", () => {
  let db: Database;
  let other: Database;
  const jobs = ["test_job_a", "test_job_b"];

  beforeAll(async () => {
    db = createDb(url as string);
    other = createDb(url as string);
    await migrate(db, { migrationsFolder });
    await db.delete(statsJobRuns).where(inArray(statsJobRuns.job, jobs));
  });

  afterAll(async () => {
    await db.delete(statsJobRuns).where(inArray(statsJobRuns.job, jobs));
    await db.$client.end();
    await other.$client.end();
  });

  it("stores the last success and keeps it through a later failure", async () => {
    const store = new PgStatsJobStore(db);
    const success = new Date("2026-10-14T03:00:00Z");
    await store.withLock(async (s) => {
      expect(await s.getLastSuccess("test_job_a")).toBeNull();
      await s.recordSuccess("test_job_a", success);
    });
    await store.withLock(async (s) => {
      await s.recordFailure("test_job_a", new Date("2026-10-15T03:00:00Z"), "boom");
    });

    const [row] = await db.select().from(statsJobRuns).where(eq(statsJobRuns.job, "test_job_a"));
    expect(row.lastSuccessAt?.toISOString()).toBe(success.toISOString());
    expect(row.lastError).toBe("boom");
    // A fresh instance (an ingest restart) reads the same state.
    const seen = await new PgStatsJobStore(other).withLock((s) => s.getLastSuccess("test_job_a"));
    expect(seen?.toISOString()).toBe(success.toISOString());
  });

  it("lets only one instance run at a time", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let entered: () => void = () => {};
    const inside = new Promise<void>((r) => {
      entered = r;
    });

    const first = new PgStatsJobStore(db).withLock(async () => {
      entered();
      await held;
      return "first";
    });
    await inside;
    const second = await new PgStatsJobStore(other).withLock(async () => "second");
    release();

    expect(second).toBeNull();
    expect(await first).toBe("first");
    // Released with the run.
    expect(await new PgStatsJobStore(other).withLock(async () => "after")).toBe("after");
  });

  it("keeps what was recorded when the run fails later on, and releases the lock", async () => {
    // A backfill of many months runs for a long time; a ClickHouse error, a
    // deploy restart or a dropped connection late in it must not undo the
    // tables already marked done — the next run would start over.
    const store = new PgStatsJobStore(db);
    const success = new Date("2026-10-14T03:00:00Z");
    await expect(
      store.withLock(async (s) => {
        await s.recordSuccess("test_job_b", success);
        throw new Error("ClickHouse went away");
      }),
    ).rejects.toThrow("ClickHouse went away");

    const [row] = await db.select().from(statsJobRuns).where(eq(statsJobRuns.job, "test_job_b"));
    expect(row.lastSuccessAt?.toISOString()).toBe(success.toISOString());
    expect(await new PgStatsJobStore(other).withLock(async () => "free")).toBe("free");
  });

  it("lists the projects that exist", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: `stats-${Date.now()}@test.local`, name: "Stats" })
      .returning();
    const [ws] = await db
      .insert(workspaces)
      .values({ name: "Stats WS", slug: `stats-${Date.now()}`, ownerId: user.id })
      .returning();
    const [project] = await db
      .insert(projects)
      .values({ workspaceId: ws.id, name: "P", slug: "p" })
      .returning();
    try {
      const listed = await new PgStatsJobStore(db).withLock((s) => s.listProjects());
      expect(listed).toContainEqual({ id: project.id, retentionMonths: 13 });

      await db.delete(projects).where(eq(projects.id, project.id));
      const after = await new PgStatsJobStore(db).withLock((s) => s.listProjects());
      expect((after ?? []).map((p) => p.id)).not.toContain(project.id);
    } finally {
      await db.delete(workspaces).where(eq(workspaces.id, ws.id));
      await db.delete(users).where(eq(users.id, user.id));
    }
  });
});
