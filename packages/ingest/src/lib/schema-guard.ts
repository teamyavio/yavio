import type { ClickHouseClient } from "@clickhouse/client";
import { EVENTS_COLUMNS } from "./event-enricher.js";
import { TOOL_REGISTRY_COLUMNS } from "./tool-registry.js";

/** The tables ingest writes, and every column it writes to each, with its type. */
export const WRITTEN_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  events: EVENTS_COLUMNS,
  tool_registry: TOOL_REGISTRY_COLUMNS,
};

/** Skips the startup check when set to "1": for an emergency only (schema-guard.ts). */
export const SKIP_SCHEMA_CHECK_VARIABLE = "INGEST_SKIP_SCHEMA_CHECK";

export interface ColumnProblem {
  table: string;
  column: string;
  expected: string;
  /** The column's type in ClickHouse, or null when the column is missing. */
  actual: string | null;
}

/**
 * The columns ingest writes that ClickHouse lacks or holds with another type
 * than ingest writes (`WRITTEN_COLUMNS`). Extra columns in ClickHouse are
 * fine. Read from system.columns as the ingest user, which sees the columns
 * of the tables it is granted.
 *
 * Why at startup: a migration not yet applied that adds a column makes
 * ClickHouse skip the new field on every row without an error
 * (input_format_skip_unknown_fields), and a changed type makes it refuse
 * every row, which the batch writer then drops. Stopping ingest instead
 * makes the deploy fail where it went wrong: migrate before ingest
 * (docker-compose: `depends_on: migrate`).
 */
export async function columnProblems(
  clickhouse: ClickHouseClient,
  expected: Readonly<Record<string, Readonly<Record<string, string>>>> = WRITTEN_COLUMNS,
): Promise<ColumnProblem[]> {
  const result = await clickhouse.query({
    query:
      "SELECT table, name, type FROM system.columns WHERE database = currentDatabase() AND table IN {tables:Array(String)}",
    query_params: { tables: Object.keys(expected) },
    format: "JSONEachRow",
  });
  const actual = new Map<string, string>();
  for (const row of await result.json<{ table: string; name: string; type: string }>()) {
    actual.set(`${row.table}.${row.name}`, row.type);
  }
  const problems: ColumnProblem[] = [];
  for (const [table, columns] of Object.entries(expected)) {
    for (const [column, type] of Object.entries(columns)) {
      const found = actual.get(`${table}.${column}`) ?? null;
      if (found !== type) problems.push({ table, column, expected: type, actual: found });
    }
  }
  return problems;
}

/** One line per problem, for the startup error. */
export function describeProblems(problems: ColumnProblem[]): string {
  return problems
    .map((p) =>
      p.actual === null
        ? `${p.table}.${p.column} is missing (ingest writes ${p.expected})`
        : `${p.table}.${p.column} is ${p.actual}, ingest writes ${p.expected}`,
    )
    .join("; ");
}
