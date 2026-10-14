import { createClient } from "@clickhouse/client";
import { ErrorCode, YavioError } from "@yavio/shared/errors";

/**
 * Request timeout for a client that waits on mutations or runs month-wide
 * aggregations: the ingest statistics job, the dashboard's eraser. The
 * library default of 30 s suits dashboard queries, but a synchronous
 * `ALTER TABLE events DELETE` (mutations_sync = 1) or an INSERT ... SELECT
 * over a month of events runs for minutes on a large table. With the default
 * the client gave up at 30 s while the statement kept running, the caller
 * recorded a failure and retried on its next tick, and every retry queued one
 * more full-table mutation.
 */
export const LONG_RUNNING_REQUEST_TIMEOUT_MS = 60 * 60 * 1000;

export interface ClickHouseClientOptions {
  /** HTTP request timeout; the library default (30 s) when omitted. */
  requestTimeoutMs?: number;
}

/**
 * Create a ClickHouse client for the admin/default user (used for migrations),
 * or for the URL given.
 */
export function createClickHouseClient(url?: string, options: ClickHouseClientOptions = {}) {
  const resolved = url ?? process.env.CLICKHOUSE_URL;
  if (!resolved) {
    throw new YavioError(
      ErrorCode.INFRA.REQUIRED_ENV_VAR_MISSING,
      "CLICKHOUSE_URL is not set and no url was provided.",
      500,
      { variable: "CLICKHOUSE_URL" },
    );
  }
  return createClient({
    url: resolved,
    ...(options.requestTimeoutMs !== undefined && { request_timeout: options.requestTimeoutMs }),
  });
}
