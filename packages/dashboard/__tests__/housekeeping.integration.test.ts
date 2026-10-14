import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { HOUSEKEEPING_LOCK_KEY, HousekeepingJob } from "@/lib/housekeeping/job";
import { type Database, createDb } from "@yavio/db/client";
import {
  apiKeys,
  invitations,
  loginAttempts,
  projects,
  sessions,
  stripeWebhookEvents,
  users,
  verificationTokens,
  workspaces,
} from "@yavio/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Postgres housekeeping (#92): what each table keeps, against a real
// Postgres. Rows are checked by id, so other files' rows do not matter.

const pgUrl = process.env.DATABASE_URL;

const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ahead = (ms: number) => new Date(NOW.getTime() + ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe.skipIf(!pgUrl)("HousekeepingJob (#92)", () => {
  let db: Database;
  let other: Database;
  let userId = "";
  let ws = "";
  const kept: Record<string, string[]> = {};
  const gone: Record<string, string[]> = {};

  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

  beforeAll(async () => {
    db = createDb(pgUrl as string);
    other = createDb(pgUrl as string);
    await migrate(db, { migrationsFolder: join(process.cwd(), "..", "db", "drizzle") });

    const [user] = await db
      .insert(users)
      .values({ email: `hk-${randomUUID()}@test.local`, name: "H" })
      .returning();
    userId = user.id;
    const [w] = await db
      .insert(workspaces)
      .values({ name: "HK", slug: `hk-${randomUUID().slice(0, 8)}`, ownerId: userId })
      .returning();
    ws = w.id;
    const [project] = await db
      .insert(projects)
      .values({ workspaceId: ws, name: "P", slug: "p" })
      .returning();

    const email = `attempt-${randomUUID()}@test.local`;
    const attempts = await db
      .insert(loginAttempts)
      .values([
        { email, ipAddress: "192.0.2.1", attemptedAt: ago(25 * HOUR) },
        { email, ipAddress: "192.0.2.1", attemptedAt: ago(HOUR) },
      ])
      .returning();
    gone.login_attempts = [attempts[0].id];
    kept.login_attempts = [attempts[1].id];

    const sess = await db
      .insert(sessions)
      .values([
        { userId, token: randomUUID(), expiresAt: ago(MIN) },
        { userId, token: randomUUID(), expiresAt: ahead(DAY) },
      ])
      .returning();
    gone.sessions = [sess[0].id];
    kept.sessions = [sess[1].id];

    const tokens = await db
      .insert(verificationTokens)
      .values([
        { userId, tokenHash: randomUUID(), type: "email", expiresAt: ago(MIN) },
        {
          userId,
          tokenHash: randomUUID(),
          type: "email",
          expiresAt: ahead(HOUR),
          usedAt: ago(MIN),
        },
        { userId, tokenHash: randomUUID(), type: "email", expiresAt: ahead(HOUR) },
      ])
      .returning();
    gone.verification_tokens = ids(tokens.slice(0, 2));
    kept.verification_tokens = [tokens[2].id];

    const invite = (expiresAt: Date, acceptedAt: Date | null = null) => ({
      workspaceId: ws,
      email: `invitee-${randomUUID()}@test.local`,
      role: "member",
      token: randomUUID(),
      invitedBy: userId,
      expiresAt,
      acceptedAt,
    });
    const invs = await db
      .insert(invitations)
      .values([
        invite(ago(2 * DAY)),
        invite(ago(2 * DAY), ago(5 * DAY)),
        invite(ago(HOUR)),
        invite(ahead(DAY)),
      ])
      .returning();
    gone.invitations = ids(invs.slice(0, 2));
    kept.invitations = ids(invs.slice(2));

    const key = (revokedAt: Date | null) => ({
      projectId: project.id,
      workspaceId: ws,
      keyHash: randomUUID(),
      keyPrefix: "yav_",
      revokedAt,
    });
    const keys = await db
      .insert(apiKeys)
      .values([key(ago(400 * DAY)), key(ago(10 * DAY)), key(null)])
      .returning();
    gone.api_keys = [keys[0].id];
    kept.api_keys = ids(keys.slice(1));

    const hooks = await db
      .insert(stripeWebhookEvents)
      .values([
        { eventId: `evt_${randomUUID()}`, eventType: "invoice.paid", processedAt: ago(31 * DAY) },
        { eventId: `evt_${randomUUID()}`, eventType: "invoice.paid", processedAt: ago(DAY) },
      ])
      .returning({ id: stripeWebhookEvents.eventId });
    gone.stripe_webhook_events = [hooks[0].id];
    kept.stripe_webhook_events = [hooks[1].id];
  });

  afterAll(async () => {
    if (ws) await db.delete(workspaces).where(eq(workspaces.id, ws));
    if (userId) await db.delete(users).where(eq(users.id, userId));
    await db?.$client.end();
    await other?.$client.end();
  });

  it("does nothing while another instance holds the lock", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let entered: () => void = () => {};
    const inside = new Promise<void>((r) => {
      entered = r;
    });
    const holder = other.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${HOUSEKEEPING_LOCK_KEY})`);
      entered();
      await held;
    });
    await inside;
    try {
      expect(await new HousekeepingJob({ db }).runOnce(NOW)).toBeNull();
    } finally {
      release();
      await holder;
    }
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(loginAttempts)
      .where(inArray(loginAttempts.id, gone.login_attempts));
    expect(n).toBe(1);
  });

  it("deletes exactly what has run out, and reports it", async () => {
    const report = await new HousekeepingJob({ db }).runOnce(NOW);
    expect(report).not.toBeNull();
    for (const [table, deleted] of Object.entries(gone)) {
      expect(report?.[table], table).toBeGreaterThanOrEqual(deleted.length);
    }

    const tables = {
      login_attempts: loginAttempts,
      sessions,
      verification_tokens: verificationTokens,
      invitations,
      api_keys: apiKeys,
    } as const;
    const present = async (table: keyof typeof tables | "stripe_webhook_events") => {
      const all = [...(gone[table] ?? []), ...(kept[table] ?? [])];
      if (table === "stripe_webhook_events") {
        const t = stripeWebhookEvents;
        const rows = await db.select({ id: t.eventId }).from(t).where(inArray(t.eventId, all));
        return ids(rows).sort();
      }
      const t = tables[table];
      return ids(await db.select({ id: t.id }).from(t).where(inArray(t.id, all))).sort();
    };
    for (const table of [...Object.keys(tables), "stripe_webhook_events"] as const) {
      const name = table as keyof typeof tables | "stripe_webhook_events";
      expect(await present(name), name).toEqual([...kept[name]].sort());
    }
  });
});
