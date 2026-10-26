import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type ClickHouseClient, createClient } from "@clickhouse/client";

const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "test";

/**
 * Whether a URL's host is this machine: `localhost`, `0.0.0.0`, the
 * 127.0.0.0/8 range, `[::1]`, `[::]` or an IPv4-mapped loopback address.
 */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "::" ||
    /^::ffff:(127\.|7f[0-9a-f]{2}:)/.test(host) ||
    /^0+(\.0+){0,3}$/.test(host) ||
    // Also the short forms ("127.1") a non-http URL leaves as written.
    /^127(\.\d+){0,3}$/.test(host)
  );
}

/**
 * The ClickHouse the integration tests use. They truncate `events`, replace
 * whole partitions and create databases, so they run only against one named
 * explicitly in CLICKHOUSE_URL — never by default — and not against port
 * 8123 on this machine, the development ClickHouse of docker-compose.yml,
 * outside CI (where 8123 is the job's own service) unless
 * INGEST_TESTS_CLICKHOUSE_OK=1.
 */
export function testClickHouseUrl(): string {
  const url = process.env.CLICKHOUSE_URL;
  if (!url) {
    throw new Error(
      "Set CLICKHOUSE_URL to a throwaway ClickHouse (docker-compose.test.yml): the integration tests truncate and replace data.",
    );
  }
  const { hostname, port } = new URL(url);
  if (
    isLocalHost(hostname) &&
    port === "8123" &&
    process.env.CI !== "true" &&
    process.env.INGEST_TESTS_CLICKHOUSE_OK !== "1"
  ) {
    throw new Error(
      "CLICKHOUSE_URL is port 8123 on this machine, the development ClickHouse: the integration tests truncate and replace data. Use a throwaway one, or set INGEST_TESTS_CLICKHOUSE_OK=1.",
    );
  }
  return url;
}

/**
 * The Postgres the server-process tests give ingest: named explicitly in
 * DATABASE_URL, and not port 5432 or 5433 on this machine (the development
 * Postgres) outside CI unless INGEST_TESTS_POSTGRES_OK=1.
 */
export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Set DATABASE_URL to a throwaway Postgres (docker-compose.test.yml) for the ingest server-process tests.",
    );
  }
  const { hostname, port } = new URL(url);
  if (
    isLocalHost(hostname) &&
    ["", "5432", "5433"].includes(port) &&
    process.env.CI !== "true" &&
    process.env.INGEST_TESTS_POSTGRES_OK !== "1"
  ) {
    throw new Error(
      "DATABASE_URL is port 5432 or 5433 on this machine, the development Postgres. Use a throwaway one, or set INGEST_TESTS_POSTGRES_OK=1.",
    );
  }
  return url;
}

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
    client = createClient({ url: testClickHouseUrl(), password: CLICKHOUSE_PASSWORD });
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
