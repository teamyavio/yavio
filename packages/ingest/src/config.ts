import { ErrorCode, YavioError } from "@yavio/shared/errors";

export interface AppConfig {
  port: number;
  databaseUrl: string;
  clickhouseUrl: string;
  apiKeyHashSecret: string;
  jwtSecret: string;
}

/** The least-privileged ClickHouse user ingest can do its job as. */
const INGEST_CH_USER = "yavio_ingest";

/**
 * Force the ClickHouse connection onto the ingest-specific user.
 *
 * CLICKHOUSE_URL names the `default` superuser because migrations need DDL, so
 * every consumer of that variable inherits full rights unless it narrows them.
 * `yavio_ingest` is granted exactly what this service does — SELECT+INSERT on
 * events, INSERT on tool_registry — and nothing else, so a bug or an injected
 * payload here cannot read another tenant's rows or alter a table.
 *
 * The password is carried over from the URL unchanged: all ClickHouse users on
 * this deployment share one password (see analytics-client.ts, which narrows to
 * yavio_dashboard the same way). Malformed URLs are left alone so the existing
 * validation reports the problem rather than a URL parse error.
 */
function withIngestUser(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = INGEST_CH_USER;
    return parsed.toString();
  } catch {
    return url;
  }
}

export function loadConfig(): AppConfig {
  const port = Number.parseInt(process.env.PORT ?? "3001", 10);
  const databaseUrl = process.env.DATABASE_URL;
  const clickhouseUrl = process.env.CLICKHOUSE_URL
    ? withIngestUser(process.env.CLICKHOUSE_URL)
    : undefined;
  const apiKeyHashSecret = process.env.API_KEY_HASH_SECRET;
  const jwtSecret = process.env.JWT_SECRET;

  if (!databaseUrl) {
    throw new YavioError(
      ErrorCode.INFRA.REQUIRED_ENV_VAR_MISSING,
      "DATABASE_URL is required",
      500,
      { variable: "DATABASE_URL" },
    );
  }

  if (!clickhouseUrl) {
    throw new YavioError(
      ErrorCode.INFRA.REQUIRED_ENV_VAR_MISSING,
      "CLICKHOUSE_URL is required",
      500,
      { variable: "CLICKHOUSE_URL" },
    );
  }

  if (!apiKeyHashSecret) {
    throw new YavioError(
      ErrorCode.INFRA.REQUIRED_ENV_VAR_MISSING,
      "API_KEY_HASH_SECRET is required",
      500,
      { variable: "API_KEY_HASH_SECRET" },
    );
  }

  if (!jwtSecret) {
    throw new YavioError(ErrorCode.INFRA.REQUIRED_ENV_VAR_MISSING, "JWT_SECRET is required", 500, {
      variable: "JWT_SECRET",
    });
  }

  return { port, databaseUrl, clickhouseUrl, apiKeyHashSecret, jwtSecret };
}
