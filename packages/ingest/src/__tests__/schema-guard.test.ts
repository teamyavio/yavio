import type { ClickHouseClient } from "@clickhouse/client";
import { describe, expect, it, vi } from "vitest";
import { columnProblems, describeProblems } from "../lib/schema-guard.js";

function fakeColumns(rows: Array<{ table: string; name: string; type: string }>) {
  const query = vi.fn(async () => ({ json: async () => rows }));
  return { client: { query } as unknown as ClickHouseClient, query };
}

const expected = {
  events: { event_id: "String", tokens_in: "Nullable(UInt32)", session_source: "Nullable(String)" },
  tool_registry: { tool_name: "String" },
};

describe("columnProblems", () => {
  it("reports a missing column and another type; extra columns are fine", async () => {
    const ch = fakeColumns([
      { table: "events", name: "event_id", type: "String" },
      { table: "events", name: "tokens_in", type: "Nullable(UInt64)" },
      { table: "events", name: "added_later", type: "String" },
      { table: "tool_registry", name: "tool_name", type: "String" },
    ]);
    const problems = await columnProblems(ch.client, expected);
    expect(problems).toEqual([
      {
        table: "events",
        column: "tokens_in",
        expected: "Nullable(UInt32)",
        actual: "Nullable(UInt64)",
      },
      { table: "events", column: "session_source", expected: "Nullable(String)", actual: null },
    ]);
    expect(describeProblems(problems)).toBe(
      "events.tokens_in is Nullable(UInt64), ingest writes Nullable(UInt32); events.session_source is missing (ingest writes Nullable(String))",
    );
    expect(ch.query).toHaveBeenCalledWith(
      expect.objectContaining({ query_params: { tables: ["events", "tool_registry"] } }),
    );
  });

  it("reports nothing when every column is there with its type", async () => {
    const ch = fakeColumns([
      { table: "events", name: "event_id", type: "String" },
      { table: "events", name: "tokens_in", type: "Nullable(UInt32)" },
      { table: "events", name: "session_source", type: "Nullable(String)" },
      { table: "tool_registry", name: "tool_name", type: "String" },
    ]);
    expect(await columnProblems(ch.client, expected)).toEqual([]);
  });
});
