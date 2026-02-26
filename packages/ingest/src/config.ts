import { ErrorCode, YavioError } from "@yavio/shared/errors";

export interface AppConfig {
  port: number;
  databaseUrl: string;
  clickhouseUrl: string;
  apiKeyHashSecret: string;
  jwtSecret: string;
}

export function loadConfig(): AppConfig {
  const port = Number.parseInt(process.env.PORT ?? "3001", 10);
  const databaseUrl = process.env.DATABASE_URL;
  const clickhouseUrl = process.env.CLICKHOUSE_URL;
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
