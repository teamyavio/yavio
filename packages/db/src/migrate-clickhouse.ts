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
