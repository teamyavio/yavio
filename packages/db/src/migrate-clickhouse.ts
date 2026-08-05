import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ErrorCode, YavioError } from "@yavio/shared/errors";
import { createClickHouseClient } from "./clickhouse-client.js";
import { splitStatements, versionFromFilename } from "./migrate-clickhouse-helpers.js";

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
  const users: Array<[user: string, envVar: string]> = [
    ["yavio_ingest", "CLICKHOUSE_INGEST_PASSWORD"],
    ["yavio_dashboard", "CLICKHOUSE_DASHBOARD_PASSWORD"],
  ];

  for (const [user, envVar] of users) {
    const password = process.env[envVar];
    if (!password) continue;

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

    await applyUserPasswords();
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
