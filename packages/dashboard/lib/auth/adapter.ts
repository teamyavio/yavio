import { randomUUID } from "node:crypto";
import type { Database } from "@yavio/db/client";
import { oauthAccounts, users } from "@yavio/db/schema";
import { and, eq } from "drizzle-orm";
import type { Adapter, AdapterAccount, AdapterUser } from "next-auth/adapters";

/**
 * Custom NextAuth adapter that maps to the existing Yavio schema.
 *
 * Key differences from the default adapter:
 * - `emailVerified` is a boolean, not a Date
 * - OAuth accounts use `oauth_accounts` table with custom column names
 * - User IDs are UUIDs, not cuid
 * - Session methods omitted (JWT strategy handles sessions)
 */
export function YavioAdapter(db: Database): Adapter {
  return {
    async createUser(data) {
      const id = randomUUID();
      const avatarUrl = data.image ?? null;
      await db.insert(users).values({
        id,
        email: data.email,
        name: data.name ?? null,
        emailVerified: !!data.emailVerified,
        avatarUrl,
      });
      return toAdapterUser({
        id,
        email: data.email,
        name: data.name ?? null,
        emailVerified: !!data.emailVerified,
        avatarUrl,
      });
    },

    async getUser(id) {
      const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return rows[0] ? toAdapterUser(rows[0]) : null;
    },

    async getUserByEmail(email) {
      const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
      return rows[0] ? toAdapterUser(rows[0]) : null;
    },

    async getUserByAccount({ providerAccountId, provider }) {
      const rows = await db
        .select({ user: users })
        .from(oauthAccounts)
        .innerJoin(users, eq(oauthAccounts.userId, users.id))
        .where(
          and(
            eq(oauthAccounts.provider, provider),
            eq(oauthAccounts.providerAccountId, providerAccountId),
          ),
        )
        .limit(1);
      return rows[0] ? toAdapterUser(rows[0].user) : null;
    },

    async updateUser(data) {
      if (!data.id) throw new Error("User ID required for update");
      const values: Record<string, unknown> = { updatedAt: new Date() };
      if (data.name !== undefined) values.name = data.name;
      if (data.email !== undefined) values.email = data.email;
      if (data.emailVerified !== undefined) values.emailVerified = !!data.emailVerified;
      if (data.image !== undefined) {
        values.avatarUrl = data.image;
      }
      await db.update(users).set(values).where(eq(users.id, data.id));
      const rows = await db.select().from(users).where(eq(users.id, data.id)).limit(1);
      if (!rows[0]) throw new Error("User not found after update");
      return toAdapterUser(rows[0]);
    },

    async deleteUser(id) {
      await db.delete(users).where(eq(users.id, id));
    },

    async linkAccount(account) {
      await db.insert(oauthAccounts).values({
        userId: account.userId,
        provider: account.provider,
        providerAccountId: account.providerAccountId,
        accessToken: account.access_token ?? null,
        refreshToken: account.refresh_token ?? null,
        expiresAt: account.expires_at ? new Date(account.expires_at * 1000) : null,
      });
    },

    async unlinkAccount({ providerAccountId, provider }) {
      await db
        .delete(oauthAccounts)
        .where(
          and(
            eq(oauthAccounts.provider, provider),
            eq(oauthAccounts.providerAccountId, providerAccountId),
          ),
        );
    },
  };
}

interface UserLike {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  emailVerified: boolean | null;
}

function toAdapterUser(row: UserLike): AdapterUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    image: row.avatarUrl,
    emailVerified: row.emailVerified ? new Date() : null,
  };
}

/** AdapterAccount type helper */
export type { AdapterAccount, AdapterUser };
