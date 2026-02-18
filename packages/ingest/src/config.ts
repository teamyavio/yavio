import { ErrorCode, YavioError } from "@yavio/shared/errors";

export interface AppConfig {
  port: number;
  databaseUrl: string;
  clickhouseUrl: string;
}

export function loadConfig(): AppConfig {
  const port = Number.parseInt(process.env.PORT ?? "3001", 10);
  const databaseUrl = process.env.DATABASE_URL;
  const clickhouseUrl = process.env.CLICKHOUSE_URL;

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

  return { port, databaseUrl, clickhouseUrl };
}
