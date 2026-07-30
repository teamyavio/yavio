import { describe, expect, it } from "vitest";
import { McpToolError } from "../lib/mcp/errors";
import { validateFreeQuery } from "../lib/mcp/sql-guard";

function rejected(sql: string): string {
  try {
    validateFreeQuery(sql);
  } catch (err) {
    expect(err).toBeInstanceOf(McpToolError);
    return (err as McpToolError).message;
  }
  throw new Error(`expected rejection for: ${sql}`);
}

describe("run_query SQL guard — attack corpus", () => {
  it("rejects query-level SETTINGS overrides (tenant-isolation escape)", () => {
    expect(
      rejected("SELECT count() FROM events SETTINGS SQL_workspace_id = 'victim-workspace'"),
    ).toContain("SETTINGS");
    rejected("select 1 settings max_execution_time=0");
    rejected("SELECT 1 SeTtInGs readonly=0");
  });

  it("rejects system database access in every spelling", () => {
    rejected("SELECT query FROM system.query_log");
    rejected("SELECT * FROM system . query_log");
    rejected("SELECT * FROM SYSTEM.tables");
    rejected('SELECT * FROM "system"."query_log"');
    rejected("SELECT * FROM `system`.`query_log`");
    rejected("SELECT * FROM information_schema.tables");
    rejected("SELECT (SELECT count() FROM system.processes)");
  });

  it("rejects multi-statement and non-SELECT statements", () => {
    rejected("SELECT 1; DROP TABLE events");
    rejected("INSERT INTO events SELECT * FROM events");
    rejected("DROP TABLE events");
    rejected("ALTER TABLE events DELETE WHERE 1");
    rejected("TRUNCATE TABLE events");
    rejected("SHOW TABLES");
    rejected("DESCRIBE events");
    rejected("EXISTS events");
    rejected("KILL QUERY WHERE 1");
    rejected("SET readonly = 0");
    rejected("SYSTEM FLUSH LOGS");
    rejected("OPTIMIZE TABLE events");
  });

  it("rejects comments that could hide keywords", () => {
    rejected("SELECT 1 -- SETTINGS x=1");
    rejected("SELECT /* hidden */ 1");
    rejected("SELECT 1 # comment");
  });

  it("rejects table functions (network/file/cross-db access)", () => {
    rejected("SELECT * FROM url('http://169.254.169.254/', 'CSV', 's String')");
    rejected("SELECT * FROM remote('victim-host', default.events)");
    rejected("SELECT * FROM remoteSecure('victim', system.one)");
    rejected("SELECT * FROM file('/etc/passwd', 'CSV', 's String')");
    rejected("SELECT * FROM s3('http://bucket/x', 'CSV')");
    rejected("SELECT * FROM mysql('host', 'db', 'table', 'u', 'p')");
    rejected("SELECT * FROM postgresql('host', 'db', 'table', 'u', 'p')");
    rejected("SELECT * FROM cluster('default', system.one)");
    rejected("SELECT * FROM clusterAllReplicas('default', system.one)");
    rejected("SELECT * FROM merge('default', '^events')");
    rejected("SELECT * FROM merge ('default', '^events')");
    rejected("SELECT dictGetString(x) FROM dictionary('d')");
    rejected("SELECT * FROM generateRandom('a UInt8')");
    rejected("SELECT * FROM executable('cat /etc/passwd', 'TSV', 's String')");
  });

  it("rejects output redirection and format overrides", () => {
    rejected("SELECT 1 INTO OUTFILE '/tmp/x'");
    rejected("SELECT 1 FORMAT Native");
  });

  it("rejects oversized and empty queries", () => {
    rejected("");
    rejected("   ");
    rejected(`SELECT ${"1+".repeat(5000)}1`);
  });
});

describe("run_query SQL guard — legitimate analytics queries pass", () => {
  it("accepts plain aggregations", () => {
    expect(
      validateFreeQuery("SELECT count() FROM events WHERE event_type = 'tool_call'"),
    ).toContain("count()");
  });

  it("accepts WITH ... SELECT", () => {
    validateFreeQuery(
      "WITH totals AS (SELECT event_name, count() c FROM events GROUP BY event_name) SELECT * FROM totals ORDER BY c DESC",
    );
  });

  it("accepts ClickHouse functions whose names embed banned words", () => {
    // formatDateTime contains "format", countMerge contains "merge",
    // offset contains "set", input_values contains "input"
    validateFreeQuery(
      "SELECT formatDateTime(timestamp, '%Y-%m') m, count() FROM events GROUP BY m LIMIT 10 OFFSET 5",
    );
    validateFreeQuery("SELECT JSONExtractString(input_values, 'query') FROM events LIMIT 5");
    validateFreeQuery("SELECT numbers.number FROM numbers(7)");
  });

  it("strips a trailing semicolon", () => {
    expect(validateFreeQuery("SELECT 1;")).toBe("SELECT 1");
  });

  it("accepts the row-policy-covered tables", () => {
    validateFreeQuery("SELECT count() FROM sessions_mv");
    validateFreeQuery("SELECT count() FROM users_mv");
    validateFreeQuery("SELECT tool_name FROM tool_registry LIMIT 50");
  });
});
