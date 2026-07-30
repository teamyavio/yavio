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
  // Dollar-quoted strings ($$…$$ / $tag$…$tag$) would let an apostrophe open a
  // phantom literal that hides the rest of the query from the scanner below.
  // Analytics SQL has no need for them.
  { pattern: /\$\w*\$/, reason: "dollar-quoted strings are not allowed" },
  // Name rule, prefix-matched: `merge` also bans mergeTreeIndex(,
  // `cluster` also bans clusterAllReplicas(, `url` also bans urlCluster(.
  // A leading `\w*\.` catches the dotted form (default.mergeTreeIndex(...)),
  // which ClickHouse rejects today but which must not depend on that.
  {
    pattern:
      /\b(url|remote|file|s3|oss|cosn|azureBlobStorage|gcs|hdfs|hive|iceberg|deltaLake|hudi|mysql|postgresql|sqlite|mongodb|redis|jdbc|odbc|cluster|dictionary|dictGet|joinGet|executable|input|merge|view|loop|fuzz|generateRandom|generateSeries|generate_series|numbers|zeros|values|timeSeries|null)[A-Za-z0-9_]*\s*\(/i,
    reason: "table functions are not allowed",
  },
];

/** Tables the row policies cover — the only ones worth querying anyway. */
export const QUERYABLE_TABLES = ["events", "sessions_mv", "users_mv", "tool_registry"] as const;

/**
 * Table references may also be comma-separated (`FROM a, b`), which a
 * FROM/JOIN-anchored pattern cannot see. Verified live: `FROM events AS e,
 * mergeTreeIndex(default, events) AS m` reads raw index tuples straight past
 * the row policies, and needs no source privilege, so the database itself
 * does not stop it.
 *
 * Locating the table list needs a real parse of that clause. Two earlier
 * attempts failed for instructive reasons, both caught by review:
 *  - a region regex ended the list at ON/USING, so a join condition hid the
 *    following comma;
 *  - a flag cleared on clause keywords let an ALIAS that spells one
 *    (`FROM events AS window, evil(...)`) switch the rule off, since an alias
 *    is attacker-controlled text.
 *
 * So walk the clause as a small state machine instead. The alias slot is
 * consumed as an alias — that is what it is — rather than being mistaken for
 * a clause boundary, and a comma is only meaningful in EXPECT_REF/AFTER_REF.
 */

/** Keywords that unambiguously end a table list; never plausible as a bare alias. */
const HARD_TERMINATORS = new Set([
  "where",
  "prewhere",
  "group",
  "order",
  "limit",
  "having",
  "union",
  "select",
  "qualify",
]);

/**
 * Keywords that end a clause in principle but are far likelier to appear as
 * an alias here. Treated as an alias so they cannot disarm the scan; the
 * cost is only that a genuine `WINDOW`/`FORMAT` clause is scanned a little
 * further, which never causes a false rejection on its own.
 */
const SOFT_TERMINATORS = new Set(["window", "format", "into", "settings"]);

type TableState = "outside" | "expect_ref" | "after_ref" | "alias_next" | "join_cond";

function assertNoTableFunctionInTableList(sql: string): void {
  const reject = () => {
    throw new McpToolError(
      "Query rejected: table functions are not allowed (query the events/sessions_mv/users_mv/tool_registry tables).",
    );
  };
  // Optionally database-qualified, with whitespace tolerated around the dot:
  // `fn(`, `default.fn(`, `default . fn(` are all one call in table position.
  const isCallAt = (index: number) =>
    /^\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*\s*\(/.test(sql.slice(index));

  // One state per parenthesis depth — subqueries have their own table list.
  const state: TableState[] = ["outside"];
  const aliasUsed: boolean[] = [false];
  const top = () => state.length - 1;
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
      state.push("outside");
      aliasUsed.push(false);
      continue;
    }
    if (char === ")") {
      if (state.length > 1) {
        state.pop();
        aliasUsed.pop();
        // A closing paren completes a subquery used as a table reference.
        if (state[top()] === "expect_ref") state[top()] = "after_ref";
      }
      continue;
    }

    if (char === ",") {
      if (state[top()] === "after_ref" || state[top()] === "join_cond") {
        // Table separator: the next reference must not be a function call.
        if (isCallAt(i + 1)) reject();
        state[top()] = "expect_ref";
        aliasUsed[top()] = false;
      }
      continue;
    }

    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i));
    if (!word) continue;
    const lower = word[0].toLowerCase();
    const after = i + word[0].length;

    if (state[top()] === "alias_next") {
      // Whatever follows AS is the alias, keyword-looking or not.
      state[top()] = "after_ref";
      aliasUsed[top()] = true;
      i = after - 1;
      continue;
    }

    if (lower === "from" || lower === "join") {
      if (isCallAt(after)) reject();
      state[top()] = "expect_ref";
      aliasUsed[top()] = false;
    } else if (lower === "as" && state[top()] === "after_ref") {
      state[top()] = "alias_next";
    } else if (lower === "on" || lower === "using") {
      if (state[top()] === "after_ref") state[top()] = "join_cond";
    } else if (HARD_TERMINATORS.has(lower)) {
      state[top()] = "outside";
      aliasUsed[top()] = false;
    } else if (state[top()] === "expect_ref") {
      // The table reference itself; a call here was already rejected above.
      if (isCallAt(i)) reject();
      state[top()] = "after_ref";
      // Skip a database qualifier so `default . events` is one reference.
      const qualified = /^[A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*/.exec(
        sql.slice(i),
      );
      if (qualified) i = i + qualified[0].length - 1;
      continue;
    } else if (state[top()] === "after_ref" && !aliasUsed[top()]) {
      // Bare alias — including one that spells a soft clause keyword.
      if (SOFT_TERMINATORS.has(lower) || !HARD_TERMINATORS.has(lower)) {
        aliasUsed[top()] = true;
      }
    }
    i = after - 1;
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
