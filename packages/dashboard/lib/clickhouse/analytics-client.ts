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

    // Guarded like the sibling rewrites in ingest/config.ts and lib/clickhouse.ts:
    // a malformed CLICKHOUSE_URL must surface as the existing configuration
    // error, not as an opaque TypeError [ERR_INVALID_URL] on every query route.
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      dashboardClient = createClient({ url: baseUrl, request_timeout: 30_000 });
      return dashboardClient;
    }
    parsed.username = "yavio_dashboard";
    // Prefer this user's OWN password when configured; fall back to the URL's
    // so deployments still sharing one secret across users keep working.
    const ownPassword = process.env.CLICKHOUSE_DASHBOARD_PASSWORD;
    if (ownPassword) parsed.password = ownPassword;

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
        // ClickHouse 25.8 changed the default to 0, so UInt64/Int64 values such
        // as count() arrive as JSON numbers instead of strings (#95). Pinned to
        // the old shape so the query code, its tests and run_query results stay
        // unchanged; switching to numbers is its own change.
        output_format_json_quote_64bit_integers: 1,
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

    // @clickhouse/client lifts the `Code: NNN` prefix of a server error into
    // a `code` field and its `(TYPE_NAME)` suffix into `type`, so the message
    // carries neither; network failures use non-numeric codes like
    // ECONNREFUSED.
    const { code: clientCode, type: clientType } = (err ?? {}) as {
      code?: unknown;
      type?: unknown;
    };
    const numericCode =
      typeof clientCode === "number"
        ? clientCode
        : typeof clientCode === "string" && /^\d+$/.test(clientCode)
          ? Number(clientCode)
          : Number(/Code:\s*(\d+)/.exec(message)?.[1] ?? Number.NaN);
    const fromServer = Number.isFinite(numericCode);

    // A query cut by max_execution_time is 159 TIMEOUT_EXCEEDED with the text
    // "Timeout exceeded: elapsed … ms, maximum: … ms" — matched on the code
    // and type, never on the text (#157). The text match is for errors
    // without a server code: the client's own request_timeout ("Timeout
    // error." in @clickhouse/client). A server error that merely mentions a
    // timeout (209 SOCKET_TIMEOUT, a column named `timeout`) is not one.
    if (
      numericCode === 159 ||
      clientType === "TIMEOUT_EXCEEDED" ||
      (!fromServer && /timeout/i.test(message))
    ) {
      throw new AnalyticsQueryError(
        ErrorCode.DASHBOARD.ANALYTICS_QUERY_TIMEOUT,
        "Analytics query timed out. Please try a smaller date range.",
        504,
        detail,
      );
    }

    // 241 MEMORY_LIMIT_EXCEEDED has three sources, told apart by the text
    // only. The query's own limit (max_memory_usage: "Query memory limit
    // exceeded", in older releases "Memory limit (for query) exceeded") is
    // deterministic: the same query over the same range needs the same
    // memory, so retry advice is wrong and narrowing is what works (#157).
    // 422, not 400: the request is valid, it is too big to compute; not 5xx:
    // nothing is down. The server's total ("(total) memory limit exceeded")
    // and the user's ("User memory limit exceeded", "(for user)") depend on
    // what else runs at the same time: those stay the retryable 502 below,
    // as does any 241 whose text names neither.
    if (
      (numericCode === 241 || clientType === "MEMORY_LIMIT_EXCEEDED") &&
      /query memory limit exceeded|memory limit \(for query\) exceeded/i.test(message)
    ) {
      throw new AnalyticsQueryError(
        ErrorCode.DASHBOARD.ANALYTICS_QUERY_MEMORY_EXCEEDED,
        "This query needs more memory than the database allows. Narrow the date range or simplify the query.",
        422,
        detail,
      );
    }

    // Server-side codes that ARE worth retrying: overload and resource
    // pressure, not a malformed query. Misclassifying these would tell the
    // dashboard's own analytics routes that a transient spike is permanent.
    // (159 and the per-query 241 are query limits, answered above.)
    const TRANSIENT_SERVER_CODES = new Set([
      164, // READONLY
      201, // QUOTA_EXCEEDED
      202, // TOO_MANY_SIMULTANEOUS_QUERIES
      203, // NO_FREE_CONNECTION
      209, // SOCKET_TIMEOUT
      210, // NETWORK_ERROR
      241, // MEMORY_LIMIT_EXCEEDED of the server's total or the user's
      252, // TOO_MANY_PARTS
      373, // SESSION_IS_LOCKED
      425, // SYSTEM_ERROR
    ]);

    // Did ClickHouse parse the request and reject it (unknown column, bad
    // function, budget overrun)? That is permanent — telling the caller to
    // "try again later" sends a model into a retry loop on a query that can
    // never succeed.
    const rejectedByServer = fromServer && !TRANSIENT_SERVER_CODES.has(numericCode);

    if (rejectedByServer) {
      throw new AnalyticsQueryError(
        // Its own code: 3406 is catalogued as "ClickHouse unavailable", which
        // is the opposite condition, and reusing it would have made the
        // dashboard's alerting unable to tell an outage from a bad query.
        ErrorCode.DASHBOARD.ANALYTICS_QUERY_REJECTED,
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
