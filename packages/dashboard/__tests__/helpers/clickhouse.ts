import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type ClickHouseClient, createClient } from "@clickhouse/client";

/**
 * A real ClickHouse for dashboard query tests: the CI service of the
 * test-dashboard job, locally docker-compose.test.yml. Null outside CI when
 * none is configured (the caller skips and says so).
 */
export function clickhouseUrl(): URL | null {
  const raw = process.env.CLICKHOUSE_URL;
  if (!raw) {
    if (process.env.CI) throw new Error("CLICKHOUSE_URL is not set in CI");
    return null;
  }
  const url = new URL(raw);
  url.username = "default";
  url.password = process.env.CLICKHOUSE_PASSWORD ?? url.password ?? "test";
  return url;
}

const MIGRATIONS = join(process.cwd(), "..", "db", "migrations", "clickhouse");

/** Apply the ClickHouse migrations not yet recorded, the way the migrator does. */
export async function applyMigrations(admin: ClickHouseClient): Promise<void> {
  await admin.command({
    query: `CREATE TABLE IF NOT EXISTS schema_migrations (
      version String, applied_at DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = MergeTree() ORDER BY version`,
  });
  const done = await admin.query({
    query: "SELECT version FROM schema_migrations",
    format: "JSONEachRow",
  });
  const applied = new Set((await done.json<{ version: string }>()).map((r) => r.version));
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const version = file.slice(0, 4);
    if (applied.has(version)) continue;
    if (version !== "0001") {
      const sql = readFileSync(join(MIGRATIONS, file), "utf8")
        .split("\n")
        .map((line) => line.replace(/--.*$/, ""))
        .join("\n");
      for (const stmt of sql
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)) {
        await admin.command({ query: stmt });
      }
    }
    await admin.insert({
      table: "schema_migrations",
      values: [{ version }],
      format: "JSONEachRow",
    });
  }
}

export function adminClient(url: URL): ClickHouseClient {
  return createClient({ url: url.toString() });
}
