import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { splitStatements, versionFromFilename } from "../../migrate-clickhouse-helpers.js";

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? "http://localhost:8123";
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "test";
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "migrations",
  "clickhouse",
);

let client: ClickHouseClient | undefined;

export function getClient(): ClickHouseClient {
  if (!client) {
    client = createClient({ url: CLICKHOUSE_URL, password: CLICKHOUSE_PASSWORD });
  }
  return client;
}

/**
 * Run all ClickHouse migrations in order.
 * Replicates the logic from migrate-clickhouse.ts main().
 */
export async function runMigrations() {
  const ch = getClient();

  // Bootstrap schema_migrations table
  await ch.command({
    query: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     String,
        applied_at  DateTime64(3, 'UTC') DEFAULT now64(3)
      ) ENGINE = MergeTree() ORDER BY version
    `,
  });

  // Get already-applied versions
  const result = await ch.query({
    query: "SELECT version FROM schema_migrations",
    format: "JSONEachRow",
  });
  const applied = new Set((await result.json<{ version: string }>()).map((r) => r.version));

  // Read and apply migration files
  const files = (await readdir(migrationsDir)).filter((f: string) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const version = versionFromFilename(file);
    if (applied.has(version)) continue;

    if (version === "0001") {
      await ch.insert({
        table: "schema_migrations",
        values: [{ version }],
        format: "JSONEachRow",
      });
      continue;
    }

    const sql = await readFile(join(migrationsDir, file), "utf-8");
    for (const stmt of splitStatements(sql)) {
      await ch.command({ query: stmt });
    }

    await ch.insert({
      table: "schema_migrations",
      values: [{ version }],
      format: "JSONEachRow",
    });
  }
}

/** Drop all ClickHouse tables and views to reset state. */
export async function dropAll() {
  const ch = getClient();
  for (const obj of [
    "VIEW IF EXISTS sessions_mv",
    "VIEW IF EXISTS users_mv",
    "TABLE IF EXISTS events",
    "TABLE IF EXISTS tool_registry",
    "TABLE IF EXISTS schema_migrations",
  ]) {
    await ch.command({ query: `DROP ${obj}` });
  }
}

/** Close the ClickHouse client. */
export async function disconnect() {
  if (client) {
    await client.close();
    client = undefined;
  }
}
