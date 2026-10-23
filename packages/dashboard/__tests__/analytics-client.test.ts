import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.fn();

vi.mock("@clickhouse/client", () => ({
  createClient: vi.fn(() => ({
    query: mockQuery,
  })),
}));

// Must set env before importing
vi.stubEnv("CLICKHOUSE_URL", "http://default:pass@localhost:8123");

// Dynamic import to pick up mocks
const { queryAnalytics, AnalyticsQueryError } = await import("@/lib/clickhouse/analytics-client");

// The real parser: on an HTTP error response @clickhouse/client hands the
// server's body to parseError, which lifts `Code: NNN` into `code` and the
// `(TYPE)` suffix into `type` — the message keeps neither.
const { parseError } =
  await vi.importActual<typeof import("@clickhouse/client")>("@clickhouse/client");

describe("queryAnalytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("injects workspace and project settings", async () => {
    mockQuery.mockResolvedValue({
      json: () => Promise.resolve([{ count: 42 }]),
    });

    const result = await queryAnalytics({
      workspaceId: "ws_123",
      projectId: "proj_456",
      query: "SELECT count() AS count FROM events",
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        clickhouse_settings: {
          // 64-bit integers stay JSON strings on ClickHouse 25.8+ (#95).
          output_format_json_quote_64bit_integers: 1,
          SQL_workspace_id: "ws_123",
          SQL_project_id: "proj_456",
        },
        format: "JSONEachRow",
      }),
    );
    expect(result).toEqual([{ count: 42 }]);
  });

  it("passes query params", async () => {
    mockQuery.mockResolvedValue({
      json: () => Promise.resolve([]),
    });

    await queryAnalytics({
      workspaceId: "ws_1",
      projectId: "proj_1",
      query: "SELECT count() FROM events WHERE event_type = {type:String}",
      params: { type: "tool_call" },
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: { type: "tool_call" },
      }),
    );
  });

  it("throws AnalyticsQueryError with TIMEOUT code on timeout", async () => {
    mockQuery.mockRejectedValue(new Error("TIMEOUT exceeded"));

    await expect(
      queryAnalytics({
        workspaceId: "ws_1",
        projectId: "proj_1",
        query: "SELECT 1",
      }),
    ).rejects.toThrow(AnalyticsQueryError);

    try {
      await queryAnalytics({
        workspaceId: "ws_1",
        projectId: "proj_1",
        query: "SELECT 1",
      });
    } catch (err) {
      expect((err as InstanceType<typeof AnalyticsQueryError>).code).toBe("YAVIO-3405");
      expect((err as InstanceType<typeof AnalyticsQueryError>).status).toBe(504);
    }
  });

  it("throws AnalyticsQueryError with UNAVAILABLE code on other errors", async () => {
    mockQuery.mockRejectedValue(new Error("Connection refused"));

    try {
      await queryAnalytics({
        workspaceId: "ws_1",
        projectId: "proj_1",
        query: "SELECT 1",
      });
    } catch (err) {
      expect((err as InstanceType<typeof AnalyticsQueryError>).code).toBe("YAVIO-3406");
      expect((err as InstanceType<typeof AnalyticsQueryError>).status).toBe(502);
    }
  });
});

describe("error classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks a database-REJECTED query as permanent, not retryable", async () => {
    // Claude flagged this in live testing: an unknown column came back as
    // "please try again later", which invites a retry loop on a query that
    // can never succeed no matter how often it is repeated.
    // Shape the real client produces: the numeric code is lifted OUT of the
    // message into a `code` field, which is why matching the message alone
    // was not enough (observed live against the dev deployment).
    mockQuery.mockRejectedValue(
      Object.assign(new Error("Unknown expression identifier 'nope' in scope SELECT..."), {
        code: "47",
        type: "UNKNOWN_IDENTIFIER",
      }),
    );
    const err = await queryAnalytics({
      workspaceId: "w",
      projectId: "p",
      query: "SELECT nope FROM events",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(AnalyticsQueryError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("rejected this query");
    expect(err.message).not.toContain("try again later");
    // the raw text still reaches the model so it can correct itself
    expect(err.detail).toContain("Unknown expression identifier");
  });

  it("keeps a genuine outage retryable", async () => {
    mockQuery.mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8123"), { code: "ECONNREFUSED" }),
    );
    const err = await queryAnalytics({
      workspaceId: "w",
      projectId: "p",
      query: "SELECT count() FROM events",
    }).catch((e) => e);

    expect(err.status).toBe(502);
    expect(err.message).toContain("try again later");
  });

  it("keeps a timeout distinct and actionable", async () => {
    mockQuery.mockRejectedValue(new Error("Read timeout exceeded"));
    const err = await queryAnalytics({
      workspaceId: "w",
      projectId: "p",
      query: "SELECT count() FROM events",
    }).catch((e) => e);

    expect(err.status).toBe(504);
    expect(err.message).toContain("smaller date range");
  });
});

describe("query limits (#157)", () => {
  const run = () =>
    queryAnalytics({
      workspaceId: "w",
      projectId: "p",
      query: "SELECT count() FROM events",
    }).catch((e) => e);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports a query cut by max_execution_time as the timeout, not a transient failure", async () => {
    const cut = parseError(
      "Code: 159. DB::Exception: Timeout exceeded: elapsed 30001.42 ms, maximum: 30000 ms. (TIMEOUT_EXCEEDED) (version 26.8.1.1 (official build))",
    );
    // The shape the bug hid behind: neither TIMEOUT nor timeout in the text.
    expect(cut.message).not.toMatch(/TIMEOUT|timeout/);
    mockQuery.mockRejectedValue(cut);

    const err = await run();

    expect(err).toBeInstanceOf(AnalyticsQueryError);
    expect(err.status).toBe(504);
    expect(err.code).toBe("YAVIO-3405");
    expect(err.message).toContain("timed out");
    expect(err.message).not.toContain("try again later");
    expect(err.detail).toContain("Timeout exceeded: elapsed");
  });

  it("matches the timeout on the error type alone", async () => {
    mockQuery.mockRejectedValue(
      Object.assign(new Error("Timeout exceeded: elapsed 30001.42 ms, maximum: 30000 ms."), {
        type: "TIMEOUT_EXCEEDED",
      }),
    );

    const err = await run();

    expect(err.status).toBe(504);
    expect(err.code).toBe("YAVIO-3405");
  });

  it("reports a memory-limit overrun as its own permanent error, without retry advice", async () => {
    mockQuery.mockRejectedValue(
      parseError(
        "Code: 241. DB::Exception: Query memory limit exceeded: would use 9.32 GiB (attempt to allocate chunk of 4194304 bytes), maximum: 9.31 GiB.: While executing AggregatingTransform. (MEMORY_LIMIT_EXCEEDED) (version 26.8.1.1 (official build))",
      ),
    );

    const err = await run();

    expect(err).toBeInstanceOf(AnalyticsQueryError);
    expect(err.status).toBe(422);
    expect(err.code).toBe("YAVIO-3408");
    expect(err.message).toContain("more memory than the database allows");
    expect(err.message).toContain("Narrow the date range");
    expect(err.message).not.toMatch(/try again|retry/i);
    expect(err.detail).toContain("memory limit exceeded");

    // What every analytics API route returns for it (err.toResponse()).
    const res = err.toResponse();
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: err.message, code: "YAVIO-3408" });
  });

  it("hands the memory message to the model through the MCP tool boundary", async () => {
    const { runTool } = await import("@/lib/mcp/errors");
    mockQuery.mockRejectedValue(
      parseError(
        "Code: 241. DB::Exception: (total) memory limit exceeded: would use 14.40 GiB (attempt to allocate chunk of 4194304 bytes), current RSS: 13.98 GiB, maximum: 14.40 GiB. OvercommitTracker decision: Query was selected to stop by OvercommitTracker. (MEMORY_LIMIT_EXCEEDED) (version 26.8.1.1 (official build))",
      ),
    );

    const result = await runTool(async () => {
      await queryAnalytics({ workspaceId: "w", projectId: "p", query: "SELECT 1" });
      throw new Error("unreachable");
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("YAVIO-3408");
    expect(text).toContain("more memory than the database allows");
    expect(text).toContain("Database says: (total) memory limit exceeded");
    expect(text).not.toContain("try again later");
  });

  it("reports the client's own request timeout as the timeout", async () => {
    // Verbatim what @clickhouse/client 1.17 rejects with when request_timeout
    // (30 s here) runs out: no server code, and a capital T.
    mockQuery.mockRejectedValue(new Error("Timeout error."));

    const err = await run();

    expect(err.status).toBe(504);
    expect(err.code).toBe("YAVIO-3405");
  });

  it("keeps a server socket timeout retryable — the text match is for client errors only", async () => {
    mockQuery.mockRejectedValue(
      parseError(
        "Code: 209. DB::Exception: Timeout exceeded while reading from socket (peer: 10.0.0.2:9000, local: 10.0.0.1:41234, 300000 ms). (SOCKET_TIMEOUT) (version 26.8.1.1 (official build))",
      ),
    );

    const err = await run();

    expect(err.status).toBe(502);
    expect(err.code).toBe("YAVIO-3406");
    expect(err.message).toContain("try again later");
  });

  it("does not read a rejected query that merely names a timeout column as a timeout", async () => {
    mockQuery.mockRejectedValue(
      parseError(
        "Code: 47. DB::Exception: Unknown expression identifier `timeout` in scope SELECT timeout FROM events. (UNKNOWN_IDENTIFIER) (version 26.8.1.1 (official build))",
      ),
    );

    const err = await run();

    expect(err.status).toBe(400);
    expect(err.code).toBe("YAVIO-3407");
  });
});
