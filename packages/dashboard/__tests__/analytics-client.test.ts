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
