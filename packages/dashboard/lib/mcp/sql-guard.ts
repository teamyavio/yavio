import { McpToolError } from "./errors";

/**
 * Validation gate in front of run_query. This is defense-in-depth, not the
 * tenant boundary: the query executes as the SELECT-only `yavio_dashboard`
 * ClickHouse user whose row policies hard-filter every table to the
 * workspace set by the server. The gate's job is to reject the known escape
 * hatches (query-level SETTINGS overrides, system tables, table functions,
 * multi-statements) with a message the model can act on.
 */

const MAX_QUERY_LENGTH = 8_000;

/** Statement must be a single read. */
const ALLOWED_START = /^(select|with)\b/i;

/**
 * Conservative keyword bans — matched anywhere, including string literals.
 * A legitimate analytics query has no business containing any of these; a
 * false positive costs a reworded query, a false negative costs isolation.
 */
const BANNED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /--|\/\*|#/, reason: "comments are not allowed" },
  {
    pattern: /\bsettings\b/i,
    reason: "the SETTINGS clause is not allowed (server-managed)",
  },
  { pattern: /\bformat\b/i, reason: "the FORMAT clause is not allowed (server-managed)" },
  { pattern: /\binto\s+outfile\b/i, reason: "INTO OUTFILE is not allowed" },
  {
    pattern:
      /\b(insert|alter|create|drop|truncate|rename|attach|detach|optimize|grant|revoke|set|kill|system|exchange|move|undrop)\b/i,
    reason: "only SELECT statements are allowed",
  },
  {
    pattern: /\b(system|information_schema)\s*\./i,
    reason: "only tables in the default database are queryable",
  },
  // Quoted identifiers could disguise banned names ("system"."query_log").
  // ClickHouse analytics SQL needs neither backticks nor double quotes.
  { pattern: /`/, reason: "backquoted identifiers are not allowed" },
  { pattern: /"/, reason: "double-quoted identifiers are not allowed (use plain names)" },
  // Structural rule: a function call directly in FROM/JOIN position is a
  // table function, whatever its name — this catches variants the name list
  // below has never heard of (mergeTreeIndex, urlCluster, next release's).
  {
    pattern: /\b(from|join)\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/i,
    reason:
      "table functions are not allowed (query the events/sessions_mv/users_mv/tool_registry tables)",
  },
  // Name rule, prefix-matched: `merge` also bans mergeTreeIndex(,
  // `cluster` also bans clusterAllReplicas(, `url` also bans urlCluster(.
  {
    pattern:
      /\b(url|remote|file|s3|azureBlobStorage|gcs|hdfs|iceberg|deltaLake|hudi|mysql|postgresql|sqlite|mongodb|redis|jdbc|odbc|cluster|dictionary|executable|input|merge|view|loop|fuzz|generateRandom|generateSeries|numbers|zeros|values|timeSeries)[A-Za-z0-9_]*\s*\(/i,
    reason: "table functions are not allowed",
  },
];

/** Tables the row policies cover — the only ones worth querying anyway. */
export const QUERYABLE_TABLES = ["events", "sessions_mv", "users_mv", "tool_registry"] as const;

/**
 * Table references may also be comma-separated (`FROM a, b`), which the
 * FROM/JOIN rule above cannot see. Commas are only unambiguously table
 * separators inside the table-list region, so isolate that region — from a
 * FROM/JOIN keyword up to the next clause keyword — and reject any function
 * call in it. Verified live: `FROM events AS e, mergeTreeIndex(default,
 * events) AS m` reads raw index tuples straight past the row policies, and
 * needs no source privilege, so the database itself does not stop it.
 */
const TABLE_LIST_REGION =
  /\b(?:from|join)\b([\s\S]*?)(?=\b(?:where|prewhere|group|order|limit|having|union|settings|window|on|using|format|into)\b|$)/gi;

function assertNoCommaTableFunction(sql: string): void {
  TABLE_LIST_REGION.lastIndex = 0;
  let match: RegExpExecArray | null = TABLE_LIST_REGION.exec(sql);
  while (match !== null) {
    if (/,\s*[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(match[1])) {
      throw new McpToolError(
        "Query rejected: table functions are not allowed (query the events/sessions_mv/users_mv/tool_registry tables).",
      );
    }
    match = TABLE_LIST_REGION.exec(sql);
  }
}

export function validateFreeQuery(rawSql: string): string {
  const sql = rawSql.trim().replace(/;+\s*$/, "");

  if (sql.length === 0) {
    throw new McpToolError("Empty query.");
  }
  if (sql.length > MAX_QUERY_LENGTH) {
    throw new McpToolError(`Query too long (max ${MAX_QUERY_LENGTH} characters).`);
  }
  if (sql.includes(";")) {
    throw new McpToolError("Only a single statement is allowed.");
  }
  if (!ALLOWED_START.test(sql)) {
    throw new McpToolError("Only SELECT (or WITH ... SELECT) statements are allowed.");
  }
  for (const { pattern, reason } of BANNED_PATTERNS) {
    if (pattern.test(sql)) {
      throw new McpToolError(`Query rejected: ${reason}.`);
    }
  }
  assertNoCommaTableFunction(sql);
  return sql;
}
