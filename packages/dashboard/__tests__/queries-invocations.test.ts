import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQueryAnalytics = vi.fn();

vi.mock("@/lib/clickhouse/analytics-client", () => ({
  queryAnalytics: (...args: unknown[]) => mockQueryAnalytics(...args),
}));

import { queryInvocationFeed } from "@/lib/queries/invocations";

const baseCtx = {
  workspaceId: "ws_1",
  projectId: "proj_1",
  from: "2025-01-01 00:00:00.000",
  to: "2025-01-08 00:00:00.000",
};

// #44: the merged list keeps every tool call; the intent is a column, not a filter.
describe("queryInvocationFeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists every tool call with the intent inline and the total", async () => {
    mockQueryAnalytics
      .mockResolvedValueOnce([
        {
          eventId: "evt_1",
          timestamp: "2025-01-07 12:00:00.000",
          toolName: "search",
          intent: "",
          intentSource: "",
          platform: "chatgpt",
          status: "success",
          latencyMs: 120,
          errorCategory: null,
          errorMessage: null,
          ownUserId: null,
          subjectId: null,
          sessionId: "ses_1",
          traceId: "tr_1",
          countryCode: "DE",
          inputValues: null,
          outputContent: null,
          metadata: null,
        },
      ])
      // ClickHouse serialises count()/UInt64 as a JSON string
      .mockResolvedValueOnce([{ total: "42" }])
      // #145: the page's session lookup, after the page
      .mockResolvedValueOnce([{ sessionId: "ses_1", userId: "user_9" }]);

    const result = await queryInvocationFeed(baseCtx, 1, 25);
    expect(result.invocations).toHaveLength(1);
    expect(result.invocations[0].userId).toBe("user_9");
    expect(result.invocations[0]).not.toHaveProperty("ownUserId");
    expect(result.invocations[0]).not.toHaveProperty("subjectId");
    expect(result.total).toBe(42);
    const lookup = mockQueryAnalytics.mock.calls[2][0];
    expect(lookup.query).toContain("event_type = 'identify'");
    expect(lookup.query).toContain("argMin(assumeNotNull(user_id), (timestamp, event_id))");
    expect(lookup.params.sessionIds).toEqual(["ses_1"]);

    const feed = mockQueryAnalytics.mock.calls[0][0];
    expect(feed.query).toContain("event_type = 'tool_call'");
    expect(feed.query).not.toContain("intent_signals != '{}'");
    expect(feed.query).toContain("JSONExtractString(intent_signals, 'intent') AS intent");
    expect(feed.query).toContain("country_code AS countryCode");
    expect(feed.query).toContain("ORDER BY timestamp DESC, event_id DESC");
    expect(feed.query).toContain("LIMIT 1 BY event_id");
    expect(feed.params).toMatchObject({ projectId: "proj_1", limit: 25, offset: 0 });
    const count = mockQueryAnalytics.mock.calls[1][0];
    expect(count.query).toContain("count(DISTINCT event_id)");
  });

  it("looks up only the sessions of rows without their own user_id (#145)", async () => {
    mockQueryAnalytics
      .mockResolvedValueOnce([
        { eventId: "e1", ownUserId: "ann", subjectId: "sub-1", sessionId: "s1" },
        { eventId: "e2", ownUserId: null, subjectId: "sub-2", sessionId: "s2" },
        { eventId: "e3", ownUserId: null, subjectId: null, sessionId: "" },
      ])
      .mockResolvedValueOnce([{ total: 3 }])
      .mockResolvedValueOnce([]);

    const { invocations } = await queryInvocationFeed(baseCtx, 1, 25);
    expect(mockQueryAnalytics.mock.calls[2][0].params.sessionIds).toEqual(["s2"]);
    // Nothing identified in s2: the subject, as before.
    expect(invocations.map((r) => r.userId)).toEqual(["ann", "sub-2", null]);
  });

  it("makes no lookup when every row has its own user_id", async () => {
    mockQueryAnalytics
      .mockResolvedValueOnce([
        { eventId: "e1", ownUserId: "ann", subjectId: null, sessionId: "s1" },
      ])
      .mockResolvedValueOnce([{ total: 1 }]);

    const { invocations } = await queryInvocationFeed(baseCtx, 1, 25);
    expect(invocations[0].userId).toBe("ann");
    expect(mockQueryAnalytics).toHaveBeenCalledTimes(2);
  });

  it("applies pagination offset and the platform filter to both queries", async () => {
    mockQueryAnalytics.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

    await queryInvocationFeed({ ...baseCtx, platform: ["claude"] }, 3, 10);
    const [feed, count] = mockQueryAnalytics.mock.calls.map((c) => c[0]);
    expect(feed.params.offset).toBe(20);
    expect(feed.params.limit).toBe(10);
    expect(feed.query).toContain("platform IN ({platforms:Array(String)})");
    expect(feed.params.platforms).toEqual(["claude"]);
    expect(count.query).toContain("platform IN ({platforms:Array(String)})");
    expect(count.params.platforms).toEqual(["claude"]);
  });

  it("narrows to intent-carrying calls, one tool and one status on request", async () => {
    mockQueryAnalytics.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

    await queryInvocationFeed(baseCtx, 1, 25, {
      hasIntent: true,
      tool: "search",
      status: "error",
    });
    const [feed, count] = mockQueryAnalytics.mock.calls.map((c) => c[0]);
    for (const call of [feed, count]) {
      expect(call.query).toContain("intent_signals != '{}'");
      expect(call.query).toContain("event_name = {tool:String}");
      expect(call.query).toContain("status = {status:String}");
      expect(call.params).toMatchObject({ tool: "search", status: "error" });
    }
  });

  it("binds the tool name as a parameter, never inlined", async () => {
    mockQueryAnalytics.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

    await queryInvocationFeed(baseCtx, 1, 25, { tool: "x' OR 1=1 --" });
    const feed = mockQueryAnalytics.mock.calls[0][0];
    expect(feed.query).not.toContain("OR 1=1");
    expect(feed.params.tool).toBe("x' OR 1=1 --");
  });
});
