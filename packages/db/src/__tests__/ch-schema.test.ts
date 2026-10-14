import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnect, getClient, runMigrations } from "./helpers/clickhouse.js";

describe("ClickHouse schema validation", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await disconnect();
  });

  describe("events table column types", () => {
    it("uses LowCardinality on high-cardinality-bounded columns", async () => {
      const ch = getClient();
      const result = await ch.query({
        query: `
          SELECT name, type FROM system.columns
          WHERE database = 'default' AND table = 'events'
          AND type LIKE 'LowCardinality%'
          ORDER BY name
        `,
        format: "JSONEachRow",
      });
      const colNames = (await result.json<{ name: string }>()).map((c) => c.name);

      expect(colNames).toContain("event_type");
      expect(colNames).toContain("source");
      expect(colNames).toContain("platform");
      expect(colNames).toContain("status");
      expect(colNames).toContain("error_category");
      expect(colNames).toContain("conversion_currency");
      expect(colNames).toContain("country_code");
      expect(colNames).toContain("connection_type");
    });

    it("uses DateTime64(3, UTC) for timestamp and ingested_at", async () => {
      const ch = getClient();
      const result = await ch.query({
        query: `
          SELECT name, type FROM system.columns
          WHERE database = 'default' AND table = 'events'
          AND name IN ('timestamp', 'ingested_at')
          ORDER BY name
        `,
        format: "JSONEachRow",
      });
      const cols = await result.json<{ name: string; type: string }>();
      for (const col of cols) {
        expect(col.type).toBe("DateTime64(3, 'UTC')");
      }
    });
  });

  describe("input/output capture columns (migration 0008)", () => {
    it("has input_values and output_content String columns with default '{}'", async () => {
      const ch = getClient();
      const result = await ch.query({
        query: `
          SELECT name, type, default_expression FROM system.columns
          WHERE database = 'default' AND table = 'events'
          AND name IN ('input_values', 'output_content')
          ORDER BY name
        `,
        format: "JSONEachRow",
      });
      const cols = await result.json<{
        name: string;
        type: string;
        default_expression: string;
      }>();
      expect(cols).toHaveLength(2);
      expect(cols[0]).toMatchObject({
        name: "input_values",
        type: "String",
        default_expression: "'{}'",
      });
      expect(cols[1]).toMatchObject({
        name: "output_content",
        type: "String",
        default_expression: "'{}'",
      });
    });
  });

  describe("ORDER BY correctness", () => {
    it("events table is ordered by (workspace_id, project_id, event_type, timestamp, event_id)", async () => {
      const ch = getClient();
      const result = await ch.query({
        query: `
          SELECT sorting_key FROM system.tables
          WHERE database = 'default' AND name = 'events'
        `,
        format: "JSONEachRow",
      });
      const rows = await result.json<{ sorting_key: string }>();
      expect(rows[0].sorting_key).toBe("workspace_id, project_id, event_type, timestamp, event_id");
    });
  });

  describe("TTL configured (#85 step 1)", () => {
    it("events table keeps rows 13 months from the earlier of timestamp and ingested_at", async () => {
      const ch = getClient();
      const result = await ch.query({
        query: "SHOW CREATE TABLE events",
        format: "TabSeparatedRaw",
      });
      const createStmt = await result.text();
      expect(createStmt).toContain(
        "TTL least(toDateTime(timestamp), toDateTime(ingested_at)) + toIntervalMonth(13)",
      );
      expect(createStmt).not.toMatch(/toIntervalDay\(90\)/);
      // Row-wise expiry: with ttl_only_drop_parts = 1 a monthly partition would
      // only go once ALL its rows expired, overshooting 13 months.
      expect(createStmt).not.toMatch(/ttl_only_drop_parts\s*=\s*1/);
    });

    it("expires a future-dated event 13 months after ingestion and keeps rows inside the window", async () => {
      const ch = getClient();
      const ws = "ws-ttl-test";
      const row = (id: string, timestamp: string, ingestedAt: string) =>
        `('${id}', '${ws}', 'p-ttl-test', 'tool_call', ${timestamp}, ${ingestedAt})`;
      await ch.command({
        query: `
          INSERT INTO events (event_id, workspace_id, project_id, event_type, timestamp, ingested_at)
          VALUES
            ${row("future-but-old", "now64(3) + INTERVAL 5 YEAR", "now64(3) - INTERVAL 14 MONTH")},
            ${row("old", "now64(3) - INTERVAL 14 MONTH", "now64(3)")},
            ${row("inside", "now64(3) - INTERVAL 12 MONTH", "now64(3) - INTERVAL 12 MONTH")},
            ${row("tomorrow", "now64(3) + INTERVAL 1 DAY", "now64(3)")}
        `,
      });
      // Expired rows are dropped on insert already; the forced merge makes the
      // assertion independent of when ClickHouse would apply TTL by itself.
      await ch.command({ query: "OPTIMIZE TABLE events FINAL" });

      const result = await ch.query({
        query: "SELECT event_id FROM events WHERE workspace_id = {ws:String} ORDER BY event_id",
        query_params: { ws },
        format: "JSONEachRow",
      });
      const ids = (await result.json<{ event_id: string }>()).map((r) => r.event_id);
      expect(ids).toEqual(["inside", "tomorrow"]);

      await ch.command({
        query:
          "ALTER TABLE events DELETE WHERE workspace_id = {ws:String} SETTINGS mutations_sync = 2",
        query_params: { ws },
      });
    });
  });

  describe("engine types", () => {
    it("events uses ReplacingMergeTree", async () => {
      const ch = getClient();
      const result = await ch.query({
        query: "SELECT engine FROM system.tables WHERE database = 'default' AND name = 'events'",
        format: "JSONEachRow",
      });
      const rows = await result.json<{ engine: string }>();
      expect(rows[0].engine).toBe("ReplacingMergeTree");
    });

    it("tool_registry uses ReplacingMergeTree", async () => {
      const ch = getClient();
      const result = await ch.query({
        query:
          "SELECT engine FROM system.tables WHERE database = 'default' AND name = 'tool_registry'",
        format: "JSONEachRow",
      });
      const rows = await result.json<{ engine: string }>();
      expect(rows[0].engine).toBe("ReplacingMergeTree");
    });
  });

  describe("secondary indexes on events", () => {
    it("has bloom_filter and set indexes", async () => {
      const ch = getClient();
      const result = await ch.query({
        query: `
          SELECT name, type_full FROM system.data_skipping_indices
          WHERE database = 'default' AND table = 'events'
          ORDER BY name
        `,
        format: "JSONEachRow",
      });
      const indexes = await result.json<{
        name: string;
        type_full: string;
      }>();
      const indexNames = indexes.map((i) => i.name);

      expect(indexNames).toContain("idx_trace_id");
      expect(indexNames).toContain("idx_session_id");
      expect(indexNames).toContain("idx_event_name");
      expect(indexNames).toContain("idx_platform");
      expect(indexNames).toContain("idx_status");
      expect(indexNames).toContain("idx_user_id");
    });
  });
});
