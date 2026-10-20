import { beforeEach, describe, expect, it, vi } from "vitest";

// The overview route with auth and the queries mocked: it must run the
// location breakdown with the same filters as the other Overview queries and
// return it as `locations` (#129).

const queries = vi.hoisted(() => ({
  queryOverviewKPIs: vi.fn(),
  queryInvocationsTimeSeries: vi.fn(),
  queryPlatformBreakdown: vi.fn(),
  queryTopTools: vi.fn(),
  queryLocationBreakdownOrNull: vi.fn(),
}));

vi.mock("@/lib/queries/overview", () => queries);

vi.mock("@/lib/analytics/auth", () => ({
  withAnalyticsAuth:
    () =>
    (handler: (request: Request, ctx: Record<string, string>) => Promise<Response>) =>
    (request: Request) =>
      handler(request, {
        userId: "user_1",
        workspaceId: "ws_1",
        projectId: "proj_1",
        role: "viewer",
      }),
}));

const { GET } = await import("@/app/api/analytics/[projectId]/overview/route");

const LOCATIONS = {
  totalToolCalls: 10,
  locatedToolCalls: 4,
  countries: [
    {
      countryCode: "DE",
      toolCalls: 4,
      users: 2,
      regions: [{ region: "Hesse", toolCalls: 4, users: 2 }],
    },
  ],
  unknown: { toolCalls: 6, users: 0 },
};

describe("GET /api/analytics/[projectId]/overview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queries.queryOverviewKPIs.mockResolvedValue([]);
    queries.queryInvocationsTimeSeries.mockResolvedValue([]);
    queries.queryPlatformBreakdown.mockResolvedValue([]);
    queries.queryTopTools.mockResolvedValue([]);
    queries.queryLocationBreakdownOrNull.mockResolvedValue(LOCATIONS);
  });

  it("returns the location breakdown, queried with the Overview filters", async () => {
    const call = GET as unknown as (request: Request) => Promise<Response>;
    const res = await call(
      new Request(
        "http://localhost/api/analytics/proj_1/overview?from=2026-10-01T00:00:00.000Z&to=2026-10-08T00:00:00.000Z&platform=chatgpt",
      ),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).locations).toEqual(LOCATIONS);

    expect(queries.queryLocationBreakdownOrNull).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      projectId: "proj_1",
      from: "2026-10-01 00:00:00.000",
      to: "2026-10-08 00:00:00.000",
      platform: ["chatgpt"],
    });
    expect(queries.queryLocationBreakdownOrNull.mock.calls[0][0]).toEqual(
      queries.queryPlatformBreakdown.mock.calls[0][0],
    );
  });

  it("keeps the rest of the Overview when the location query failed", async () => {
    queries.queryLocationBreakdownOrNull.mockResolvedValue(null);
    queries.queryTopTools.mockResolvedValue([{ toolName: "search", count: 3 }]);
    const call = GET as unknown as (request: Request) => Promise<Response>;
    const res = await call(new Request("http://localhost/api/analytics/proj_1/overview"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.locations).toBeNull();
    expect(body.topTools).toEqual([{ toolName: "search", count: 3 }]);
  });
});
