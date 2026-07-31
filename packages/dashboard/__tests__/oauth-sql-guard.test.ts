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

  it("rejects prefix-variant table functions (verified live: mergeTreeIndex reads raw index tuples PAST the row policies)", () => {
    rejected("SELECT * FROM mergeTreeIndex(default, events)");
    rejected("SELECT * FROM mergeTreeIndex(default, events, with_marks = true)");
    rejected("SELECT * FROM mergeTreeProjection(default, events, 'p')");
    rejected("SELECT * FROM urlCluster('c', 'http://x/', 'CSV')");
    rejected("SELECT * FROM icebergS3('http://bucket/t')");
    rejected("SELECT * FROM deltaLakeCluster('c', 'http://x')");
    rejected("SELECT * FROM hdfsCluster('c', 'hdfs://x', 'CSV')");
    rejected("SELECT * FROM numbers(100)");
    rejected("SELECT * FROM zeros(10)");
    rejected("SELECT * FROM generateSeries(1, 10)");
    rejected("SELECT * FROM timeSeriesData('db', 'ts')");
  });

  it("rejects ANY function call in FROM/JOIN position, known name or not", () => {
    rejected("SELECT * FROM someBrandNewTableFunc(1)");
    rejected("SELECT * FROM events JOIN whatever('x') ON 1=1");
    rejected("select * from x(1)");
  });

  it("rejects table functions in COMMA position too (verified live: comma-position mergeTreeIndex leaks other tenants' index tuples)", () => {
    rejected("SELECT m.* FROM events AS e, mergeTreeIndex(default, events) AS m");
    rejected("SELECT * FROM events, numbers(3)");
    // the point of the rule: names the denylist has never heard of
    rejected("SELECT * FROM events AS e, someFutureIntrospector(default, events) AS m");
    rejected("SELECT * FROM events e , brandNewFunc('x') f WHERE e.status = 'error'");
    rejected("SELECT * FROM sessions_mv AS s, anotherOne(1) AS a GROUP BY s.session_id");
  });

  it("rejects comma-position table functions AFTER a join condition (ON/USING must not end the table list)", () => {
    rejected(
      "SELECT m.* FROM events AS e JOIN sessions_mv AS s ON e.session_id = s.session_id, someFutureIntrospector(default, events) AS m",
    );
    rejected(
      "SELECT m.* FROM events AS e JOIN sessions_mv AS s USING (session_id), someFutureIntrospector(default, events) AS m",
    );
    rejected(
      "SELECT * FROM events AS e JOIN sessions_mv AS s ON greatest(e.latency_ms, 0) > 0, brandNew(1) AS b",
    );
  });

  it("rejects table functions hidden behind an ALIAS that spells a clause keyword", () => {
    // an alias is attacker-controlled text; it must not be able to switch the
    // table-list scan off (verified bypass before the state machine)
    rejected("SELECT * FROM events AS window, oss('https://a/x.csv','CSV','c String') AS m");
    rejected("SELECT * FROM events AS into, futureFn(1) AS m");
    rejected("SELECT * FROM events AS qualify, futureFn(1) AS m");
    rejected("SELECT * FROM events window, futureFn(1) AS m");
    rejected("SELECT * FROM events AS format, futureFn(1) AS m");
  });

  it("rejects dollar-quoted strings (they hid the rest of the query from the scan)", () => {
    rejected("SELECT $$'$$ AS x FROM events AS e, oss('https://a/x.csv','CSV','c String') AS m");
    rejected("SELECT $tag$'$tag$ AS x FROM events AS e, futureFn(1) AS m");
    rejected(
      "WITH q AS (SELECT $$'$$ AS z FROM events AS e, futureIntrospector(default, events) AS f) SELECT * FROM q",
    );
  });

  it("rejects database-qualified table functions, spaced or not", () => {
    rejected("SELECT * FROM default.futureIntrospector(1)");
    rejected("SELECT * FROM default . futureIntrospector(1)");
    rejected("SELECT * FROM events AS e, default.futureFn(1) AS m");
    rejected("SELECT * FROM  default  .  mergeTreeIndex ( default , events )");
  });

  it("rejects the table functions the name list previously missed", () => {
    rejected("SELECT * FROM oss('https://a/x.csv','CSV','c String')");
    rejected("SELECT * FROM cosn('https://a/x.csv','CSV','c String')");
    rejected("SELECT * FROM hive('a','b','c','d')");
    rejected("SELECT * FROM generate_series(1, 10)");
    rejected("SELECT * FROM null('x String')");
    rejected("SELECT joinGet('db.j','v',1) FROM events");
  });

  it("rejects reserved words as table aliases (verified executable: AS array + JOIN)", () => {
    // `FROM events AS array JOIN mergeTreeIndex(...)` EXECUTED against
    // ClickHouse — the alias made a real JOIN look like an ARRAY JOIN and the
    // exemption skipped the check. Aliases are attacker-chosen text, so the
    // ambiguity is refused rather than special-cased.
    expect(rejected("SELECT * FROM events AS array JOIN evil(1) AS m ON 1")).toContain("reserved");
    rejected("SELECT * FROM events AS limit JOIN evil(1) AS m ON 1");
    rejected("SELECT * FROM events AS union, evil(1)");
  });

  it("rejects a clause keyword used as an alias before a comma, even after another alias", () => {
    // `LIMIT ,` is not valid SQL, so the keyword must be an alias. The earlier
    // guard only applied before an alias had been consumed.
    rejected("SELECT * FROM events x limit, evil(1)");
    rejected("SELECT * FROM events a having, evil(1)");
    rejected("SELECT * FROM (SELECT 1) t limit, evil(1)");
    rejected("SELECT * FROM events e1 e2 limit, evil(1)");
  });

  it("rejects table functions inside a subquery's table list", () => {
    rejected("SELECT * FROM (SELECT * FROM events, brandNewFunc(1)) AS sub");
    rejected("SELECT * FROM (SELECT * FROM brandNewFunc(1)) AS sub");
    rejected(
      "WITH t AS (SELECT * FROM events AS e, futureIntrospector(default, events) AS f) SELECT * FROM t",
    );
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
    // arrayJoin contains "join", fromUnixTimestamp starts with "from",
    // offset contains "set", input_values contains "input"
    validateFreeQuery(
      "SELECT formatDateTime(timestamp, '%Y-%m') m, count() FROM events GROUP BY m LIMIT 10 OFFSET 5",
    );
    validateFreeQuery("SELECT JSONExtractString(input_values, 'query') FROM events LIMIT 5");
    validateFreeQuery("SELECT countMerge(x) FROM sessions_mv GROUP BY session_id");
    validateFreeQuery("SELECT arrayJoin([1, 2, 3]) FROM events LIMIT 3");
    validateFreeQuery("SELECT fromUnixTimestamp(1690000000) FROM events LIMIT 1");
    validateFreeQuery(
      "SELECT e.event_name FROM events AS e JOIN sessions_mv AS s ON e.session_id = s.session_id",
    );
  });

  it("strips a trailing semicolon", () => {
    expect(validateFreeQuery("SELECT 1;")).toBe("SELECT 1");
  });

  it("accepts the row-policy-covered tables", () => {
    validateFreeQuery("SELECT count() FROM sessions_mv");
    validateFreeQuery("SELECT count() FROM users_mv");
    validateFreeQuery("SELECT tool_name FROM tool_registry LIMIT 50");
  });

  it("the comma rule does not trip on ordinary function calls elsewhere", () => {
    // commas inside SELECT-list, WHERE, GROUP BY, ON and HAVING function calls
    validateFreeQuery("SELECT concat(event_name, upper(status)) FROM events");
    validateFreeQuery("SELECT count() FROM events WHERE position(event_name, 'search') > 0");
    validateFreeQuery(
      "SELECT e.event_name FROM events AS e JOIN sessions_mv AS s ON s.session_id = e.session_id AND greatest(e.latency_ms, 0) > 0",
    );
    validateFreeQuery(
      "SELECT if(status = 'error', 1, 0) AS failed, count() FROM events GROUP BY failed HAVING count() > toUInt8(1)",
    );
    validateFreeQuery(
      "SELECT formatDateTime(timestamp, '%Y-%m-%d') d, count() FROM events GROUP BY d ORDER BY d LIMIT 10",
    );
    // plain multi-table comma joins stay legal
    validateFreeQuery("SELECT * FROM events, sessions_mv");
    validateFreeQuery(
      "SELECT * FROM events AS e, sessions_mv AS s WHERE e.session_id = s.session_id",
    );
    // function calls after a join condition, in ORDER/GROUP, and in subqueries
    validateFreeQuery(
      "SELECT e.event_name FROM events AS e JOIN sessions_mv AS s ON e.session_id = s.session_id ORDER BY toStartOfHour(e.timestamp), count() DESC",
    );
    validateFreeQuery(
      "SELECT * FROM (SELECT session_id, count() c FROM events GROUP BY session_id) AS sub WHERE sub.c > 1",
    );
    validateFreeQuery(
      "SELECT s.session_id, arrayStringConcat(groupArray(e.event_name), ',') FROM events AS e JOIN sessions_mv AS s USING (session_id) GROUP BY s.session_id",
    );
    // a comma inside a string literal must not be read as a table separator
    validateFreeQuery("SELECT count() FROM events WHERE event_name = 'a, count(x)'");
    // database-qualified TABLES stay legal (only qualified CALLS are refused)
    validateFreeQuery("SELECT count() FROM default.events");
    validateFreeQuery("SELECT count() FROM default . events");
    validateFreeQuery(
      "SELECT * FROM default.events AS e, default.sessions_mv AS s WHERE e.session_id = s.session_id",
    );
    validateFreeQuery("SELECT * FROM events AS a, sessions_mv AS b, users_mv AS c");
  });
});
