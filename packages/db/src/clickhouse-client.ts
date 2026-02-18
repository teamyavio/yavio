import { createClient } from "@clickhouse/client";
import { ErrorCode, YavioError } from "@yavio/shared/errors";

/**
 * Create a ClickHouse client for the admin/default user (used for migrations).
 */
export function createClickHouseClient(url?: string) {
  const resolved = url ?? process.env.CLICKHOUSE_URL;
  if (!resolved) {
    throw new YavioError(
      ErrorCode.INFRA.REQUIRED_ENV_VAR_MISSING,
      "CLICKHOUSE_URL is not set and no url was provided.",
      500,
      { variable: "CLICKHOUSE_URL" },
    );
  }
  return createClient({ url: resolved });
}
