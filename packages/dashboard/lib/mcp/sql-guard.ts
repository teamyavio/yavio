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
 * FROM/JOIN rule above cannot see. Verified live: `FROM events AS e,
 * mergeTreeIndex(default, events) AS m` reads raw index tuples straight past
 * the row policies, and needs no source privilege, so the database itself
 * does not stop it.
 *
 * Finding the table list needs real state, not a region regex: a join
 * condition (`ON …`, `USING (…)`) sits inside the FROM clause, and
 * subqueries nest their own. So scan once, tracking string literals and one
 * "am I in a table list" flag per parenthesis depth. A comma seen at the
 * current depth while that flag is set is a table separator — the token
 * after it must be a table name, never a function call.
 */
const CLAUSE_TERMINATORS = new Set([
  "where",
  "prewhere",
  "group",
  "order",
  "limit",
  "having",
  "union",
  "settings",
  "window",
  "format",
  "into",
  "select",
  "qualify",
]);

function assertNoTableFunctionInTableList(sql: string): void {
  const reject = () => {
    throw new McpToolError(
      "Query rejected: table functions are not allowed (query the events/sessions_mv/users_mv/tool_registry tables).",
    );
  };

  // One flag per paren depth: is this level currently inside a table list?
  const inTableList: boolean[] = [false];
  let quote: string | null = null;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];

    if (quote !== null) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (char === "(") {
      inTableList.push(false);
      continue;
    }
    if (char === ")") {
      if (inTableList.length > 1) inTableList.pop();
      continue;
    }

    if (char === "," && inTableList[inTableList.length - 1]) {
      // Table separator: whatever follows must not be a function call.
      if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(sql.slice(i + 1))) reject();
      continue;
    }

    // Keywords that open or close a table list at this depth.
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i));
    if (!word) continue;
    const lower = word[0].toLowerCase();
    if (lower === "from" || lower === "join") {
      inTableList[inTableList.length - 1] = true;
      // Directly-following function call (also covered by the regex above,
      // kept here so the scanner is correct on its own).
      if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(sql.slice(i + word[0].length))) reject();
    } else if (CLAUSE_TERMINATORS.has(lower)) {
      inTableList[inTableList.length - 1] = false;
    }
    i += word[0].length - 1;
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
  assertNoTableFunctionInTableList(sql);
  return sql;
}
