import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs against a ClickHouse started WITH packages/db/clickhouse/config.d/
// system-logs.xml mounted (#92): in CI the ch-config container of the test-db
// job, locally the docker-compose.test.yml service, which mounts it too.
// CI must provide it; elsewhere the suite is skipped and says so.
const url = process.env.CLICKHOUSE_CONFIG_URL;
if (!url && process.env.CI) {
  throw new Error("CLICKHOUSE_CONFIG_URL is not set; the test-db job must start ch-config");
}

// Stock 26.8 config sets <engine> for this one, which cannot be combined with
// <ttl>; it stays empty unless tracing is enabled.
const WITHOUT_TTL = ["opentelemetry_span_log"];

describe.skipIf(!url)("ClickHouse system logs with the shipped config.d (#92)", () => {
  let ch: ClickHouseClient;

  beforeAll(async () => {
    ch = createClient({ url, password: process.env.CLICKHOUSE_PASSWORD ?? "test" });
    // Creates every enabled log table that has not been written yet.
    await ch.command({ query: "SYSTEM FLUSH LOGS" });
  });

  afterAll(async () => {
    await ch?.close();
  });

  async function logTables(): Promise<Array<{ name: string; engine_full: string }>> {
    const result = await ch.query({
      query: `
        SELECT name, engine_full FROM system.tables
        WHERE database = 'system' AND name LIKE '%\\_log' AND engine LIKE '%MergeTree'
        ORDER BY name`,
      format: "JSONEachRow",
    });
    return result.json();
  }

  it("gives every system log table a 30-day TTL", async () => {
    const tables = await logTables();
    // query_log keeps every query's text, metric/trace logs were the bulk of
    // the volume on prod: name them, so the check cannot pass on an empty set.
    const names = tables.map((t) => t.name);
    for (const required of [
      "query_log",
      "metric_log",
      "asynchronous_metric_log",
      "trace_log",
      "text_log",
      "part_log",
      "processors_profile_log",
    ]) {
      expect(names).toContain(required);
    }
    const missing = tables
      .filter((t) => !WITHOUT_TTL.includes(t.name))
      .filter((t) => !t.engine_full.includes("TTL event_date + toIntervalDay(30)"))
      .map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it("does not enable logs the stock config leaves off", async () => {
    const names = (await logTables()).map((t) => t.name);
    expect(names).not.toContain("session_log");
    expect(names).not.toContain("zookeeper_log");
  });

  it("logs at warning level", async () => {
    const result = await ch.query({
      query: "SELECT value FROM system.server_settings WHERE name = 'logger.level'",
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([{ value: "warning" }]);

    const levels = await ch.query({
      query:
        "SELECT count() AS n FROM system.text_log WHERE level IN ('Trace', 'Debug', 'Information')",
      format: "JSONEachRow",
    });
    // Number(): from 25.8 a UInt64 arrives as a JSON number unless quoted (#95).
    const [{ n }] = await levels.json<{ n: string | number }>();
    expect(Number(n)).toBe(0);
  });
});
