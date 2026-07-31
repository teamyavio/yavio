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
  // Name rule. Deliberately NOT open-ended prefix matching: `null*` swallowed
  // nullIf( — the canonical safe-division idiom for error rates, and the most
  // likely thing a model writes against this schema — and `hive*`/`url*` ate
  // hiveHash( and URLHash(. Each family lists its real variants instead, and
  // the structural table-position rule below is what covers names nobody has
  // heard of yet.
  {
    pattern: new RegExp(
      String.raw`\b(?:${[
        // network / storage readers, with their Cluster and cloud variants
        "url(?:Cluster)?",
        "remote(?:Secure)?",
        "file(?:Cluster)?",
        "s3(?:Cluster)?",
        "oss",
        "cosn",
        "azureBlobStorage(?:Cluster)?",
        "gcs",
        "hdfs(?:Cluster)?",
        "hive",
        "iceberg(?:S3|Azure|HDFS|Cluster)?",
        "deltaLake(?:Cluster|S3|Azure)?",
        "hudi(?:Cluster)?",
        // external databases
        "mysql",
        "postgresql",
        "sqlite",
        "mongodb",
        "redis",
        "jdbc",
        "odbc",
        // cluster / dictionary / execution
        "cluster(?:AllReplicas)?",
        "dictionary",
        "dictGet\\w*",
        "joinGet(?:OrNull)?",
        "executable(?:Pool)?",
        "input",
        // introspection that reads past row policies
        "merge",
        "mergeTree\\w*",
        "view(?:IfPermitted)?",
        "loop",
        "fuzz\\w*",
        // generators
        "generateRandom(?:Structure)?",
        "generateSeries",
        "generate_series",
        "numbers(?:_mt)?",
        "zeros(?:_mt)?",
        "values",
        "timeSeries\\w*",
        "null",
      ].join("|")})\s*\(`,
      "i",
    ),
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

/**
 * Words that may never be used as a table alias. An alias is attacker-chosen
 * text, and four review rounds of this scanner were defeated by aliases that
 * spell a keyword: `FROM events AS window, evil(1)` and — verified executable
 * against ClickHouse — `FROM events AS array JOIN evil(1)`, where the alias
 * makes a real JOIN look like an ARRAY JOIN. Rather than teach the scanner one
 * more special case, refuse the ambiguity outright. Legitimate analytics SQL
 * has no reason to alias a table `limit` or `array`.
 */
const RESERVED_ALIASES = new Set([
  ...HARD_TERMINATORS,
  ...SOFT_TERMINATORS,
  "array",
  "as",
  "on",
  "using",
  "from",
  "join",
  "left",
  "right",
  "inner",
  "outer",
  "full",
  "cross",
  "any",
  "all",
  "asof",
  "global",
  "semi",
  "anti",
]);

function rejectReservedAlias(word: string): never {
  throw new McpToolError(
    `Query rejected: "${word}" is a reserved word and cannot be used as a table alias. Pick a different alias.`,
  );
}

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
      // Whatever follows AS is the alias — and must not be a reserved word.
      if (RESERVED_ALIASES.has(lower)) rejectReservedAlias(word[0]);
      state[top()] = "after_ref";
      aliasUsed[top()] = true;
      i = after - 1;
      continue;
    }

    // `array` reaches this scanner only as the ARRAY JOIN keyword or the
    // Array(...) type constructor. As a plain identifier it is ambiguous with
    // that keyword, and the ARRAY JOIN carve-out below reads exactly that
    // ambiguity: a CTE named `array` (`WITH array AS (...)`) puts the token
    // directly in front of a real JOIN. Refuse the identifier rather than add
    // another special case to the carve-out.
    if (lower === "array" && !/^\s*(?:join\b|\()/i.test(sql.slice(after))) {
      throw new McpToolError(
        'Query rejected: "array" is reserved here (ARRAY JOIN, Array(...)) and cannot be used as an identifier. Pick a different name.',
      );
    }

    if (lower === "from" || lower === "join") {
      // ARRAY JOIN / LEFT ARRAY JOIN takes an EXPRESSION, not a table
      // reference, so `ARRAY JOIN splitByChar(...)` is ordinary ClickHouse and
      // must not be read as a table function.
      //
      // Genuine ARRAY JOIN needs BOTH conditions, because each alone was
      // defeated. `array` must be the bare keyword immediately before JOIN
      // (aliases spelling it are refused via RESERVED_ALIASES), AND the scan
      // must sit directly after a table reference, which is the only position
      // where ARRAY JOIN is grammatical. Without the state test,
      // `... ON a = b AND 1 IN array JOIN evil(1)` — `array` being a CTE name
      // that happens to end the join condition — disarmed the check on a
      // genuine following JOIN. That string was accepted by this guard and
      // parsed by ClickHouse as a real join against a table function.
      const isArrayJoin =
        lower === "join" && state[top()] === "after_ref" && /\barray\s*$/i.test(sql.slice(0, i));
      if (!isArrayJoin) {
        if (isCallAt(after)) reject();
        state[top()] = "expect_ref";
        aliasUsed[top()] = false;
      }
    } else if (lower === "as" && state[top()] === "after_ref") {
      state[top()] = "alias_next";
    } else if (lower === "on" || lower === "using") {
      if (state[top()] === "after_ref") state[top()] = "join_cond";
    } else if (
      HARD_TERMINATORS.has(lower) &&
      // A clause keyword immediately followed by a comma is never a clause —
      // `LIMIT ,` is not valid SQL — so it must be an alias. Treating it as a
      // terminator let `FROM events x limit, evil(1)` switch the scan off.
      // Deliberately NOT conditioned on aliasUsed: the bypass above appears
      // precisely when an alias has already been consumed.
      !(state[top()] === "after_ref" && /^\s*,/.test(sql.slice(after)))
    ) {
      state[top()] = "outside";
      aliasUsed[top()] = false;
    } else if (state[top()] === "after_ref" && !aliasUsed[top()]) {
      // bare alias (including one spelling a clause keyword, handled above)
      aliasUsed[top()] = true;
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
