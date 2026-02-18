import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { Database } from "../../client.js";
import * as schema from "../../schema.js";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://yavio_service:test@localhost:5432/yavio_test";

const TEST_APP_DATABASE_URL =
  process.env.DATABASE_APP_URL ?? "postgres://yavio_app:test@localhost:5432/yavio_test";

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "drizzle");

let serviceSql: ReturnType<typeof postgres> | undefined;
let serviceDb: Database | undefined;
let appSql: ReturnType<typeof postgres> | undefined;
let appDb: Database | undefined;

/** Connect to Postgres as yavio_service (table owner, bypasses RLS). */
export function getServiceDb() {
  if (!serviceSql || !serviceDb) {
    serviceSql = postgres(TEST_DATABASE_URL, { max: 5 });
    serviceDb = drizzle(serviceSql, { schema });
  }
  return { sql: serviceSql, db: serviceDb };
}

/** Connect to Postgres as yavio_app (RLS enforced). */
export function getAppDb() {
  if (!appSql || !appDb) {
    appSql = postgres(TEST_APP_DATABASE_URL, { max: 5 });
    appDb = drizzle(appSql, { schema });
  }
  return { sql: appSql, db: appDb };
}

/**
 * Ensure the yavio_app role exists with a known password.
 * Handles both CI (no init-roles.sh) and local Docker (role already exists
 * but may have a different password).
 */
async function ensureAppRole() {
  const { sql } = getServiceDb();
  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'yavio_app') THEN
        CREATE ROLE yavio_app LOGIN PASSWORD 'test';
      ELSE
        ALTER ROLE yavio_app WITH PASSWORD 'test';
      END IF;
    END
    $$;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO yavio_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO yavio_app;
  `);
}

/** Run all Drizzle migrations against the test database. */
export async function runMigrations() {
  const { sql } = getServiceDb();
  const migrationDb = drizzle(sql);
  await migrate(migrationDb, { migrationsFolder });
  await ensureAppRole();
}

/** Truncate all application tables (respecting FK order via CASCADE). */
export async function truncateAll() {
  const { sql } = getServiceDb();
  await sql`TRUNCATE
    api_keys, invitations, verification_tokens, login_attempts,
    stripe_webhook_events, projects, workspace_members, sessions,
    oauth_accounts, workspaces, users
    CASCADE`;
}

/** Close all Postgres connection pools. */
export async function disconnect() {
  if (appSql) {
    await appSql.end();
    appSql = undefined;
    appDb = undefined;
  }
  if (serviceSql) {
    await serviceSql.end();
    serviceSql = undefined;
    serviceDb = undefined;
  }
}
