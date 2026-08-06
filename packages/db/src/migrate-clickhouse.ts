import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ErrorCode, YavioError } from "@yavio/shared/errors";
import { createClickHouseClient } from "./clickhouse-client.js";
import { assertNoPasswordlessUsers, repairPasswordlessUsers } from "./clickhouse-credentials.js";
import {
  MANAGED_USERS,
  splitStatements,
  versionFromFilename,
} from "./migrate-clickhouse-helpers.js";

const client = createClickHouseClient();

/** Migrations live alongside this package: packages/db/migrations/clickhouse/ */
const migrationsDir = join(fileURLToPath(import.meta.url), "..", "..", "migrations", "clickhouse");

/**
 * Bootstrap: ensure the schema_migrations table exists.
 * This is migration 0001 — we apply it directly and record it.
 */
async function ensureMigrationsTable(): Promise<void> {
  await client.command({
    query: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     String,
        applied_at  DateTime64(3, 'UTC') DEFAULT now64(3)
      )
      ENGINE = MergeTree()
      ORDER BY version
    `,
  });
}

/** Get the set of already-applied migration versions. */
async function getAppliedVersions(): Promise<Set<string>> {
  const result = await client.query({
    query: "SELECT version FROM schema_migrations",
    format: "JSONEachRow",
  });
  const rows = await result.json<{ version: string }>();
  return new Set(rows.map((r) => r.version));
}

/** Record a migration as applied. */
async function recordMigration(version: string): Promise<void> {
  await client.insert({
    table: "schema_migrations",
    values: [{ version }],
    format: "JSONEachRow",
  });
}

/**
 * Apply per-user ClickHouse passwords from the environment.
 *
 * Migration 0007 creates yavio_ingest and yavio_dashboard with the literal
 * 'yavio_dev', which is published in a public repository, and its `IF NOT
 * EXISTS` guard means re-running never repairs that. Nothing else in the
 * codebase ever set them — so as soon as CLICKHOUSE_PASSWORD was randomised
 * (which scripts/setup-env.sh now does), a fresh install had the `default` user
 * on a strong password while these two stayed on the published one, and every
 * connection that narrows the username authenticated with the wrong secret.
 *
 * This mirrors what migrate.ts already does for the Postgres yavio_api role:
 * the value lives in the environment, never in a migration file or the
 * migration history.
 *
 * Each is skipped when unset, so deployments that still share one password
 * across users keep working untouched.
 */
async function applyUserPasswords(): Promise<void> {
  for (const { user, envVar, warnWhenUnset } of MANAGED_USERS) {
    const password = process.env[envVar];
    if (!password) {
      // Say only what is known from here. The dashboard's fallback to the
      // CLICKHOUSE_URL superuser keys off this same variable being unset
      // (dashboard/lib/clickhouse.ts), so that consequence is certain. The
      // account's own state is not: a deployment that applied a real password
      // on an earlier run and later dropped the variable still has a working
      // user, and claiming otherwise would be exactly the manufactured
      // confidence this file keeps having to guard against.
      if (warnWhenUnset) {
        console.warn(
          `[migrate:clickhouse] ${envVar} is not set — the dashboard will erase as the CLICKHOUSE_URL superuser rather than as ${user}. Set it to close that path.`,
        );
      }
      continue;
    }

    // Refuse the placeholder outright. .env.example ships blank now, but an
    // operator upgrading from an older copy may still carry the literal — and
    // unlike before, this code APPLIES what it is given, so a stale value would
    // actively reset a working user back to a password published in a public
    // repository.
    if (password === "yavio_dev") {
      throw new YavioError(
        ErrorCode.DB.CH_MIGRATION_FAILED,
        `${envVar} is set to the published placeholder 'yavio_dev'. Set a real value (scripts/setup-env.sh generates one) or unset it to leave ${user} unchanged.`,
        500,
        { variable: envVar, user },
      );
    }

    // ClickHouse string literals honour C-style backslash escapes, so doubling
    // quotes alone is NOT sufficient here: a password ending in a backslash
    // would escape the closing quote and run the literal on. Escape the
    // backslash first, then the quote. (The Postgres sibling in migrate.ts does
    // not need this — standard_conforming_strings makes backslash literal.)
    const escaped = password.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

    // ALTER USER IF EXISTS is a silent no-op when the user is missing, so
    // checking first is what stops the log claiming success for nothing —
    // exactly the manufactured-confidence pattern this codebase keeps hitting.
    const existing = await client.query({
      query: "SELECT name FROM system.users WHERE name = {user:String}",
      query_params: { user },
      format: "JSONEachRow",
    });
    if ((await existing.json<{ name: string }>()).length === 0) {
      console.warn(
        `[migrate:clickhouse] ${envVar} is set but user ${user} does not exist — NOT applied.`,
      );
      continue;
    }

    await client.command({
      query: `ALTER USER ${user} IDENTIFIED WITH sha256_password BY '${escaped}'`,
    });
    console.log(`[migrate:clickhouse] Applied ${envVar} to user ${user}.`);
  }
}

async function main() {
  console.log("[migrate:clickhouse] Connecting to ClickHouse…");

  try {
    // Bootstrap the tracking table
    await ensureMigrationsTable();

    // Read migration files, sorted by filename
    const files = (await readdir(migrationsDir)).filter((f: string) => f.endsWith(".sql")).sort();

    const applied = await getAppliedVersions();

    let appliedCount = 0;

    for (const file of files) {
      const version = versionFromFilename(file);

      if (applied.has(version)) {
        continue;
      }

      // 0001 is the schema_migrations table itself — already created above
      if (version === "0001") {
        await recordMigration(version);
        console.log(`[migrate:clickhouse] ${file} (bootstrap — recorded)`);
        appliedCount++;
        continue;
      }

      console.log(`[migrate:clickhouse] Applying ${file}…`);

      const sql = await readFile(join(migrationsDir, file), "utf-8");
      const statements = splitStatements(sql);

      for (const stmt of statements) {
        await client.command({ query: stmt });
      }

      await recordMigration(version);
      console.log(`[migrate:clickhouse] ${file} applied.`);
      appliedCount++;
    }

    if (appliedCount === 0) {
      console.log("[migrate:clickhouse] No pending migrations.");
    } else {
      console.log(`[migrate:clickhouse] Done — ${appliedCount} migration(s) applied.`);
    }

    // Repair BEFORE applying passwords, and conditionally: migration 0012
    // originally created yavio_eraser with `no_password`, which in ClickHouse
    // accepts any credential. This puts such an account back into a state that
    // accepts none, then applyUserPasswords replaces that with the operator's
    // real password if one is configured. Doing the repair unconditionally in a
    // migration would reset WORKING credentials on every existing deployment.
    const repaired = await repairPasswordlessUsers(client);
    for (const user of repaired) {
      console.warn(
        `[migrate:clickhouse] ${user} authenticated with NO credential (ClickHouse \`no_password\` accepts any password, including a wrong one) — reset to an unusable credential.`,
      );
    }

    await applyUserPasswords();
    // Migrations above create every managed user, so they must all be visible
    // now; passing true makes the check fail rather than pass vacuously if
    // system.users turns out to be invisible to the migrating user.
    await assertNoPasswordlessUsers(client, true);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  if (err instanceof YavioError) throw err;
  throw new YavioError(
    ErrorCode.DB.CH_MIGRATION_FAILED,
    err instanceof Error ? err.message : "ClickHouse migration failed",
    500,
    { cause: err },
  );
});
