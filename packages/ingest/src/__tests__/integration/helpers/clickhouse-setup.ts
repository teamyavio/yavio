import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type ClickHouseClient, createClient } from "@clickhouse/client";

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? "http://localhost:8123";
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "test";

/**
 * Resolve the path to the ClickHouse migrations directory in @yavio/db.
 * Works from the ingest package's test directory.
 */
function migrationsDir(): string {
  return join(__dirname, "..", "..", "..", "..", "..", "db", "migrations", "clickhouse");
}

let client: ClickHouseClient | undefined;

export function getClient(): ClickHouseClient {
  if (!client) {
    client = createClient({ url: CLICKHOUSE_URL, password: CLICKHOUSE_PASSWORD });
  }
  return client;
}

/**
 * Run all ClickHouse migrations in order.
 * Simplified version of the @yavio/db migration runner.
 */
export async function runMigrations(): Promise<void> {
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
  const dir = migrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const version = file.match(/^(\d+)/)?.[1];
    if (!version || applied.has(version)) continue;

    // 0001 is the schema_migrations bootstrap — skip SQL, just record
    if (version === "0001") {
      await ch.insert({
        table: "schema_migrations",
        values: [{ version }],
        format: "JSONEachRow",
      });
      continue;
    }

    const sql = await readFile(join(dir, file), "utf-8");
    const statements = sql
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      await ch.command({ query: stmt });
    }

    await ch.insert({
      table: "schema_migrations",
      values: [{ version }],
      format: "JSONEachRow",
    });
  }
}

/** Delete all rows from the events table (preserves schema). */
export async function truncateEvents(): Promise<void> {
  const ch = getClient();
  await ch.command({ query: "TRUNCATE TABLE IF EXISTS events" });
}

/** Close the ClickHouse client. */
export async function disconnect(): Promise<void> {
  if (client) {
    await client.close();
    client = undefined;
  }
}
