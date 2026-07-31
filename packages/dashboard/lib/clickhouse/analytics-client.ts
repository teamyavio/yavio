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
  /**
   * Extra per-query ClickHouse settings (e.g. execution/row caps for
   * free-form MCP queries). Merged BEFORE the tenant-isolation settings so
   * they can never override SQL_workspace_id / SQL_project_id.
   */
  settings?: Record<string, string | number>;
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
        ...options.settings,
        SQL_workspace_id: workspaceId,
        SQL_project_id: projectId,
      },
    });

    return (await result.json()) as T[];
  } catch (err) {
    console.error("[ClickHouse] Query failed:", err);
    const message = err instanceof Error ? err.message : "Unknown ClickHouse error";
    // Raw ClickHouse error text: never sent to browsers (toResponse omits
    // it), but the MCP run_query tool surfaces it — it is the model's only
    // way to correct a bad column name instead of retrying forever.
    const detail = message.slice(0, 600);

    if (message.includes("TIMEOUT") || message.includes("timeout")) {
      throw new AnalyticsQueryError(
        ErrorCode.DASHBOARD.ANALYTICS_QUERY_TIMEOUT,
        "Analytics query timed out. Please try a smaller date range.",
        504,
        detail,
      );
    }

    // Did ClickHouse parse the request and reject it (unknown column, bad
    // function, budget overrun)? That is permanent — telling the caller to
    // "try again later" sends a model into a retry loop on a query that can
    // never succeed. @clickhouse/client lifts the `Code: NNN` prefix into a
    // numeric `code` field, so the message alone does not always carry it;
    // network failures use non-numeric codes like ECONNREFUSED.
    const clientCode = (err as { code?: unknown })?.code;
    const numericCode =
      typeof clientCode === "number"
        ? clientCode
        : typeof clientCode === "string" && /^\d+$/.test(clientCode)
          ? Number(clientCode)
          : Number(/Code:\s*(\d+)/.exec(message)?.[1] ?? Number.NaN);

    // Server-side codes that ARE worth retrying: overload and resource
    // pressure, not a malformed query. Misclassifying these would tell the
    // dashboard's own analytics routes that a transient spike is permanent.
    const TRANSIENT_SERVER_CODES = new Set([
      159, // TIMEOUT_EXCEEDED
      164, // READONLY
      201, // QUOTA_EXCEEDED
      202, // TOO_MANY_SIMULTANEOUS_QUERIES
      203, // NO_FREE_CONNECTION
      209, // SOCKET_TIMEOUT
      210, // NETWORK_ERROR
      241, // MEMORY_LIMIT_EXCEEDED
      252, // TOO_MANY_PARTS
      373, // SESSION_IS_LOCKED
      425, // SYSTEM_ERROR
    ]);

    const rejectedByServer =
      Number.isFinite(numericCode) && !TRANSIENT_SERVER_CODES.has(numericCode);

    if (rejectedByServer) {
      throw new AnalyticsQueryError(
        ErrorCode.DASHBOARD.CLICKHOUSE_UNAVAILABLE,
        "The database rejected this query. Retrying unchanged will fail the same way.",
        400,
        detail,
      );
    }

    throw new AnalyticsQueryError(
      ErrorCode.DASHBOARD.CLICKHOUSE_UNAVAILABLE,
      "Analytics query failed. Please try again later.",
      502,
      detail,
    );
  }
}

export class AnalyticsQueryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "AnalyticsQueryError";
  }

  toResponse(): Response {
    return NextResponse.json({ error: this.message, code: this.code }, { status: this.status });
  }
}
