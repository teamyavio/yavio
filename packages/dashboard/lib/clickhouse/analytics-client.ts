import { createClient } from "@clickhouse/client";
import { ErrorCode } from "@yavio/shared/error-codes";
import { NextResponse } from "next/server";

type ClickHouseClient = ReturnType<typeof createClient>;

let dashboardClient: ClickHouseClient | null = null;

/**
 * Creates (or returns cached) ClickHouse client authenticated as `yavio_dashboard`.
 * This user has SELECT-only grants + row policies enforced via custom settings.
 */
function getDashboardClient(): ClickHouseClient {
  if (!dashboardClient) {
    const baseUrl = process.env.CLICKHOUSE_URL;
    if (!baseUrl) {
      throw new Error("CLICKHOUSE_URL is not set");
    }

    const parsed = new URL(baseUrl);
    parsed.username = "yavio_dashboard";

    dashboardClient = createClient({
      url: parsed.toString(),
      request_timeout: 30_000,
    });
  }
  return dashboardClient;
}

export interface AnalyticsQueryOptions<T> {
  workspaceId: string;
  projectId: string;
  query: string;
  params?: Record<string, unknown>;
  format?: string;
}

/**
 * Execute a tenant-isolated analytics query against ClickHouse.
 *
 * Injects `SQL_workspace_id` and `SQL_project_id` as custom settings
 * on every query so ClickHouse row policies enforce tenant isolation.
 */
export async function queryAnalytics<T>(options: AnalyticsQueryOptions<T>): Promise<T[]> {
  const { workspaceId, projectId, query, params } = options;
  const client = getDashboardClient();

  try {
    const result = await client.query({
      query,
      query_params: params,
      format: "JSONEachRow",
      clickhouse_settings: {
        SQL_workspace_id: workspaceId,
        SQL_project_id: projectId,
      },
    });

    return (await result.json()) as T[];
  } catch (err) {
    console.error("[ClickHouse] Query failed:", err);
    const message = err instanceof Error ? err.message : "Unknown ClickHouse error";

    if (message.includes("TIMEOUT") || message.includes("timeout")) {
      throw new AnalyticsQueryError(
        ErrorCode.DASHBOARD.ANALYTICS_QUERY_TIMEOUT,
        "Analytics query timed out. Please try a smaller date range.",
        504,
      );
    }

    throw new AnalyticsQueryError(
      ErrorCode.DASHBOARD.CLICKHOUSE_UNAVAILABLE,
      "Analytics query failed. Please try again later.",
      502,
    );
  }
}

export class AnalyticsQueryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AnalyticsQueryError";
  }

  toResponse(): Response {
    return NextResponse.json({ error: this.message, code: this.code }, { status: this.status });
  }
}
