import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  deleteAccountWithErasure,
  deleteProjectWithErasure,
  deleteWorkspaceWithErasure,
} from "@/lib/erasure/requests";
import { ERASURE_TABLES, ErasureWorker, STALE_AFTER_MS } from "@/lib/erasure/worker";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { type Database, createDb } from "@yavio/db/client";
import {
  erasureRequests,
  invitations,
  projects,
  users,
  workspaceMembers,
  workspaces,
} from "@yavio/db/schema";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { adminClient, applyMigrations, clickhouseUrl } from "./helpers/clickhouse";

// #91 part 2 against a real Postgres and ClickHouse (both are services of the
// test-dashboard CI job). The worker runs as yavio_eraser, so this also shows
// migration 0016 granted it enough — and it still cannot read.

const chUrl = clickhouseUrl();
const pgUrl = process.env.DATABASE_URL;
const ready = Boolean(chUrl && pgUrl);
const ERASER_PASSWORD = "eraser-integration";

let db: Database;
let other: Database;
/** Users this file created; their workspaces and projects cascade with them. */
const createdUsers: string[] = [];
let admin: ClickHouseClient;
let eraser: ClickHouseClient;

const TABLES_WITH_WORKSPACE = ERASURE_TABLES.filter((t) => !t.byProjectOnly).map((t) => t.table);

async function seedPostgres() {
  const [user] = await db
    .insert(users)
    .values({ email: `erasure-${randomUUID()}@test.local`, name: "E" })
    .returning();
  createdUsers.push(user.id);
  const [ws] = await db
    .insert(workspaces)
    .values({ name: "Erase WS", slug: `erase-${randomUUID().slice(0, 8)}`, ownerId: user.id })
    .returning();
  await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: user.id, role: "owner" });
  const [p1, p2] = await db
    .insert(projects)
    .values([
      { workspaceId: ws.id, name: "P1", slug: "p1" },
      { workspaceId: ws.id, name: "P2", slug: "p2" },
    ])
    .returning();
  return { userId: user.id, ws: ws.id, p1: p1.id, p2: p2.id };
}

/** Rows for one project in every table erasure has to reach. */
async function seedClickHouse(ws: string, project: string) {
  const day = "2026-10-02";
  await admin.insert({
    table: "events",
    values: [
      {
        event_id: randomUUID(),
        workspace_id: ws,
        project_id: project,
        trace_id: "t",
        session_id: "s",
        event_type: "tool_call",
        source: "server",
        user_id: "someone",
        timestamp: `${day} 10:00:00.000`,
      },
    ],
    format: "JSONEachRow",
  });
  await admin.insert({
    table: "tool_registry",
    values: [
      {
        project_id: project,
        tool_name: "search",
        registered_at: `${day} 00:00:00.000`,
        updated_at: `${day} 00:00:00.000`,
      },
    ],
    format: "JSONEachRow",
  });
  const base = { workspace_id: ws, project_id: project };
  await admin.insert({
    table: "stats_daily",
    values: [{ ...base, slice: "total", day, event_type: "tool_call", events: 1, individuals: 1 }],
    format: "JSONEachRow",
  });
  await admin.insert({
    table: "stats_users_daily",
    values: [{ ...base, day, dau: 1, wau: 1, mau: 1 }],
    format: "JSONEachRow",
  });
  await admin.insert({
    table: "stats_users_periods",
    values: [
      { ...base, period: "month", period_start: "2026-09-01", period_end: "2026-09-30", users: 1 },
    ],
    format: "JSONEachRow",
  });
  await admin.insert({
    table: "stats_cohorts",
    values: [
      {
        ...base,
        cohort_month: "2026-09-01",
        activity_month: "2026-10-01",
        month_offset: 1,
        users: 1,
      },
    ],
    format: "JSONEachRow",
  });
}

async function rowsFor(
  column: "workspace_id" | "project_id",
  value: string,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const { table, byProjectOnly } of ERASURE_TABLES) {
    if (column === "workspace_id" && byProjectOnly) continue;
    const exists = await admin.query({
      query:
        "SELECT count() AS n FROM system.tables WHERE database = 'default' AND name = {t:String}",
      query_params: { t: table },
      format: "JSONEachRow",
    });
    if (Number((await exists.json<{ n: string }>())[0].n) === 0) continue;
    const r = await admin.query({
      query: `SELECT count() AS n FROM ${table} WHERE ${column} = {v:String}`,
      query_params: { v: value },
      format: "JSONEachRow",
    });
    out[table] = Number((await r.json<{ n: string }>())[0].n);
  }
  return out;
}

function worker(
  clickhouse: () => ClickHouseClient = () => eraser,
  logger = { info: vi.fn(), error: vi.fn() },
  database = db,
) {
  return { w: new ErasureWorker({ db: database, clickhouse, logger }), logger };
}

async function request(id: string) {
  const [row] = await db.select().from(erasureRequests).where(eq(erasureRequests.id, id));
  return row;
}

async function latestRequestFor(workspaceId: string) {
  const rows = await db
    .select()
    .from(erasureRequests)
    .where(eq(erasureRequests.workspaceId, workspaceId));
  return rows.sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())[0];
}

describe.skipIf(!ready)("erasure queue (#91 part 2)", () => {
  beforeAll(async () => {
    db = createDb(pgUrl as string);
    other = createDb(pgUrl as string);
    await migrate(db, { migrationsFolder: join(process.cwd(), "..", "db", "drizzle") });
    admin = adminClient(chUrl as URL);
    await applyMigrations(admin);
    await admin.command({ query: `ALTER USER yavio_eraser IDENTIFIED BY '${ERASER_PASSWORD}'` });
    const u = new URL((chUrl as URL).toString());
    u.username = "yavio_eraser";
    u.password = ERASER_PASSWORD;
    eraser = createClient({ url: u.toString() });
    // Earlier runs may have left work behind; start from an empty queue.
    await db.delete(erasureRequests);
  });

  afterAll(async () => {
    if (createdUsers.length > 0) {
      // Same order deleteAccountWithErasure needs: owner_id and invited_by
      // are ON DELETE no action.
      await db.delete(workspaces).where(inArray(workspaces.ownerId, createdUsers));
      await db.delete(invitations).where(inArray(invitations.invitedBy, createdUsers));
      await db.delete(users).where(inArray(users.id, createdUsers));
    }
    await eraser?.close();
    await admin?.close();
    await db?.$client.end();
    await other?.$client.end();
  });

  it("deleting a project queues it, and the worker erases it from every table", async () => {
    const t = await seedPostgres();
    await seedClickHouse(t.ws, t.p1);
    await seedClickHouse(t.ws, t.p2);

    expect(await deleteProjectWithErasure(db, t.ws, t.p1)).toBe(true);
    const queued = await latestRequestFor(t.ws);
    expect(queued).toMatchObject({ scope: "project", projectIds: [t.p1], completedAt: null });
    expect(await db.select().from(projects).where(eq(projects.id, t.p1))).toEqual([]);

    const report = await worker().w.processPending();
    expect(report?.completed).toBeGreaterThanOrEqual(1);

    expect(Object.values(await rowsFor("project_id", t.p1)).every((n) => n === 0)).toBe(true);
    // The sibling project keeps everything.
    expect(Object.values(await rowsFor("project_id", t.p2)).every((n) => n > 0)).toBe(true);
    const done = await request(queued.id);
    expect(done.completedAt).not.toBeNull();
    expect(new Set(done.tablesDone)).toEqual(new Set(ERASURE_TABLES.map((x) => x.table)));
  });

  it("deleting a workspace erases all its projects — tool_registry by the snapshotted project ids", async () => {
    const t = await seedPostgres();
    await seedClickHouse(t.ws, t.p1);
    await seedClickHouse(t.ws, t.p2);

    await deleteWorkspaceWithErasure(db, t.ws);
    const queued = await latestRequestFor(t.ws);
    expect(queued.scope).toBe("workspace");
    expect([...queued.projectIds].sort()).toEqual([t.p1, t.p2].sort());

    await worker().w.processPending();
    expect(Object.values(await rowsFor("workspace_id", t.ws)).every((n) => n === 0)).toBe(true);
    for (const p of [t.p1, t.p2]) {
      expect((await rowsFor("project_id", p)).tool_registry).toBe(0);
    }
  });

  it("deleting an account queues one request per owned workspace", async () => {
    const t = await seedPostgres();
    await deleteAccountWithErasure(db, t.userId);
    const queued = await db
      .select()
      .from(erasureRequests)
      .where(eq(erasureRequests.workspaceId, t.ws));
    expect(queued).toHaveLength(1);
    expect([...queued[0].projectIds].sort()).toEqual([t.p1, t.p2].sort());
    expect(await db.select().from(workspaces).where(eq(workspaces.id, t.ws))).toEqual([]);
    await worker().w.processPending();
  });

  it("deletes an account that invited someone into a workspace it does not own", async () => {
    // invitations.invited_by is ON DELETE no action: this used to fail.
    const owner = await seedPostgres();
    const [guest] = await db
      .insert(users)
      .values({ email: `guest-${randomUUID()}@test.local`, name: "G" })
      .returning();
    createdUsers.push(guest.id);
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: owner.ws, userId: guest.id, role: "admin" });
    await db.insert(invitations).values({
      workspaceId: owner.ws,
      email: `invitee-${randomUUID()}@test.local`,
      role: "member",
      token: randomUUID(),
      invitedBy: guest.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    await deleteAccountWithErasure(db, guest.id);
    expect(await db.select().from(users).where(eq(users.id, guest.id))).toEqual([]);
    // The owner's workspace is untouched; the guest owned nothing to erase.
    expect(await db.select().from(workspaces).where(eq(workspaces.id, owner.ws))).toHaveLength(1);
  });

  it("queues nothing when the project does not exist", async () => {
    const t = await seedPostgres();
    const before = (
      await db.select().from(erasureRequests).where(eq(erasureRequests.workspaceId, t.ws))
    ).length;
    expect(await deleteProjectWithErasure(db, t.ws, randomUUID())).toBe(false);
    const after = (
      await db.select().from(erasureRequests).where(eq(erasureRequests.workspaceId, t.ws))
    ).length;
    expect(after).toBe(before);
    await db.delete(workspaces).where(eq(workspaces.id, t.ws));
  });

  it("keeps a request queued when ClickHouse fails, remembers what is done, and retries", async () => {
    const t = await seedPostgres();
    await seedClickHouse(t.ws, t.p1);
    await deleteProjectWithErasure(db, t.ws, t.p1);
    const queued = await latestRequestFor(t.ws);

    const failing = {
      command: async (params: Parameters<ClickHouseClient["command"]>[0]) => {
        if (params.query.includes("stats_daily")) throw new Error("simulated ClickHouse outage");
        return eraser.command(params);
      },
    } as unknown as ClickHouseClient;
    const first = worker(() => failing);
    await first.w.processPending();

    const pending = await request(queued.id);
    expect(pending.completedAt).toBeNull();
    expect(pending.attempts).toBe(1);
    expect(pending.lastError).toMatch(/stats_daily: simulated ClickHouse outage/);
    expect(pending.tablesDone).toEqual(expect.arrayContaining(["events", "tool_registry"]));
    expect(pending.tablesDone).not.toContain("stats_daily");
    expect(first.logger.error).toHaveBeenCalled();

    await worker().w.processPending();
    const done = await request(queued.id);
    expect(done.completedAt).not.toBeNull();
    expect(done.attempts).toBe(2);
    expect(done.lastError).toBeNull();
    expect(Object.values(await rowsFor("project_id", t.p1)).every((n) => n === 0)).toBe(true);
  });

  it("keeps the requests already worked off when the run dies later on", async () => {
    // Progress is committed per request, not at the end of the run: the
    // deletes wait for their mutations and can take minutes, so a crash or a
    // dropped connection on the second request must not lose the first.
    const t = await seedPostgres();
    await seedClickHouse(t.ws, t.p1);
    await seedClickHouse(t.ws, t.p2);
    await deleteProjectWithErasure(db, t.ws, t.p1);
    await deleteProjectWithErasure(db, t.ws, t.p2);
    const queued = await db
      .select()
      .from(erasureRequests)
      .where(eq(erasureRequests.workspaceId, t.ws));
    const first = queued.find((r) => r.projectIds.includes(t.p1));
    const second = queued.find((r) => r.projectIds.includes(t.p2));
    if (!first || !second) throw new Error("both deletions should have queued a request");

    let stamped = 0;
    const w = new ErasureWorker({
      db,
      clickhouse: () => eraser,
      now: () => {
        if (++stamped === 2) throw new Error("process died"); // on the second request
        return new Date();
      },
    });
    await expect(w.processPending()).rejects.toThrow("process died");

    expect((await request(first.id)).completedAt).not.toBeNull();
    expect(Object.values(await rowsFor("project_id", t.p1)).every((n) => n === 0)).toBe(true);
    expect((await request(second.id)).attempts).toBe(0);

    // The lock went with the run; the next one finishes the second request.
    await worker().w.processPending();
    expect((await request(second.id)).completedAt).not.toBeNull();
  });

  it("reports a request still pending after 24 h as an error", async () => {
    const t = await seedPostgres();
    await deleteProjectWithErasure(db, t.ws, t.p1);
    const queued = await latestRequestFor(t.ws);
    await db
      .update(erasureRequests)
      .set({ requestedAt: new Date(Date.now() - STALE_AFTER_MS - 3_600_000) })
      .where(eq(erasureRequests.id, queued.id));

    const down = {
      command: async () => {
        throw new Error("still down");
      },
    } as unknown as ClickHouseClient;
    const run = worker(() => down);
    const report = await run.w.processPending();
    expect(report?.stale).toBeGreaterThanOrEqual(1);
    expect(run.logger.error.mock.calls.flat().join(" ")).toMatch(/pending for 25 h/);

    await worker().w.processPending();
  });

  it("lets only one dashboard instance work the queue at a time", async () => {
    const t = await seedPostgres();
    await deleteProjectWithErasure(db, t.ws, t.p1);

    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let entered: () => void = () => {};
    const inside = new Promise<void>((r) => {
      entered = r;
    });
    const slow = {
      command: async (params: Parameters<ClickHouseClient["command"]>[0]) => {
        entered();
        await held;
        return eraser.command(params);
      },
    } as unknown as ClickHouseClient;

    const first = worker(() => slow).w.processPending();
    await inside;
    const second = await worker(undefined, undefined, other).w.processPending();
    release();
    expect(second).toBeNull();
    expect(await first).not.toBeNull();
  });

  it("the eraser still cannot read what it erases", async () => {
    await expect(
      eraser
        .query({ query: "SELECT count() FROM events", format: "JSONEachRow" })
        .then((r) => r.json()),
    ).rejects.toThrow(/ACCESS_DENIED|Not enough privileges/);
    // Tables the eraser reaches, and none it doesn't need.
    const r = await admin.query({
      query:
        "SELECT table FROM system.grants WHERE user_name = 'yavio_eraser' AND access_type = 'ALTER DELETE' ORDER BY table",
      format: "JSONEachRow",
    });
    const granted = (await r.json<{ table: string }>()).map((g) => g.table);
    expect(granted.sort()).toEqual(ERASURE_TABLES.map((x) => x.table).sort());
    expect(TABLES_WITH_WORKSPACE).toContain("events");
  });
});
