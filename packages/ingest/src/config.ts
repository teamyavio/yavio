import { isIP } from "node:net";
import { ErrorCode, YavioError } from "@yavio/shared/errors";

export interface AppConfig {
  port: number;
  databaseUrl: string;
  clickhouseUrl: string;
  apiKeyHashSecret: string;
  jwtSecret: string;
  /** Proxy addresses whose X-Forwarded-For is trusted (TRUST_PROXY); empty = none. */
  trustProxy: string[];
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
    // Prefer this user's OWN password when one is configured. Falling back to
    // the URL's password preserves deployments where every ClickHouse user
    // still shares one secret; without the fallback, randomising
    // CLICKHOUSE_PASSWORD alone would break them.
    const own = process.env.CLICKHOUSE_INGEST_PASSWORD;
    if (own) parsed.password = own;
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * TRUST_PROXY: comma-separated IP addresses or CIDR ranges of the reverse
 * proxy in front of ingest (#94). Only requests whose socket peer matches have
 * their X-Forwarded-For honoured; everything else keeps its socket address.
 *
 * Deliberately no `true`, `*` or named ranges: if ingest's port is reachable
 * other than through the proxy, trusting everyone lets any client pick its own
 * address — a fresh rate-limit bucket per request and a forged IP in the logs.
 */
export function parseTrustProxy(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const entries = raw
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "");
  for (const entry of entries) {
    const [address, prefix, ...rest] = entry.split("/");
    const family = isIP(address);
    const max = family === 4 ? 32 : 128;
    const prefixOk = prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= max);
    if (family === 0 || rest.length > 0 || !prefixOk) {
      throw new YavioError(
        ErrorCode.INFRA.INVALID_ENV_VAR,
        `TRUST_PROXY entry "${entry}" is not an IP address or CIDR range. List the proxy's address(es) explicitly, e.g. TRUST_PROXY=172.30.240.1,172.30.241.1`,
        500,
        { variable: "TRUST_PROXY" },
      );
    }
  }
  return entries;
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

  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);

  return { port, databaseUrl, clickhouseUrl, apiKeyHashSecret, jwtSecret, trustProxy };
}
