import { isIP } from "node:net";
import { ErrorCode, YavioError } from "@yavio/shared/errors";
import type { RateLimiterConfig } from "./lib/rate-limiter.js";

export interface AppConfig {
  port: number;
  databaseUrl: string;
  clickhouseUrl: string;
  apiKeyHashSecret: string;
  jwtSecret: string;
  /** Proxy addresses whose X-Forwarded-For is trusted (TRUST_PROXY); empty = none. */
  trustProxy: string[];
  /**
   * ClickHouse URL as yavio_rollup for the statistics job (#85); undefined
   * when CLICKHOUSE_ROLLUP_PASSWORD is unset, which disables the job.
   */
  rollupClickhouseUrl: string | undefined;
  /** Rate limits set in the environment (RATE_LIMIT_*); unset ones keep their defaults. */
  rateLimits: RateLimitOverrides;
}

type Limit = Partial<Pick<RateLimiterConfig, "burstCapacity" | "ratePerSecond">>;

export interface RateLimitOverrides {
  widgetToken?: Limit;
  widgetAddress?: Limit;
  widgetProject?: Limit;
  beacon?: Limit;
}

/** The RATE_LIMIT_<name>_BURST / _PER_SECOND pairs, and what they configure. */
const RATE_LIMIT_VARS: Array<[keyof RateLimitOverrides, string]> = [
  ["widgetToken", "RATE_LIMIT_WIDGET_TOKEN"],
  ["widgetAddress", "RATE_LIMIT_WIDGET_ADDRESS"],
  ["widgetProject", "RATE_LIMIT_WIDGET_PROJECT"],
  ["beacon", "RATE_LIMIT_BEACON"],
];

function positiveNumber(variable: string, raw: string): number {
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || value <= 0) {
    throw new YavioError(
      ErrorCode.INFRA.INVALID_ENV_VAR,
      `${variable} must be a positive number, got "${raw}"`,
      500,
      { variable },
    );
  }
  return value;
}

/**
 * Rate limits from RATE_LIMIT_<name>_BURST and RATE_LIMIT_<name>_PER_SECOND
 * (the bucket's capacity, and what it refills per second). Unset or empty
 * keeps the default (lib/rate-limiter.ts); anything but a positive number
 * stops the start.
 */
export function parseRateLimits(env: NodeJS.ProcessEnv): RateLimitOverrides {
  const overrides: RateLimitOverrides = {};
  for (const [name, prefix] of RATE_LIMIT_VARS) {
    const limit: Limit = {};
    const burst = env[`${prefix}_BURST`];
    const rate = env[`${prefix}_PER_SECOND`];
    if (burst !== undefined && burst !== "") {
      limit.burstCapacity = positiveNumber(`${prefix}_BURST`, burst);
    }
    if (rate !== undefined && rate !== "") {
      limit.ratePerSecond = positiveNumber(`${prefix}_PER_SECOND`, rate);
    }
    if (Object.keys(limit).length > 0) overrides[name] = limit;
  }
  return overrides;
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

/**
 * The statistics job's own ClickHouse user (#85). Unlike yavio_ingest there is
 * no fallback to the URL's password: yavio_rollup is created
 * unauthenticatable (migration 0015) and only gets a password from
 * CLICKHOUSE_ROLLUP_PASSWORD, so without one there is nothing to connect as.
 */
function rollupUrl(url: string | undefined): string | undefined {
  const password = process.env.CLICKHOUSE_ROLLUP_PASSWORD;
  if (!url || !password) return undefined;
  try {
    const parsed = new URL(url);
    parsed.username = "yavio_rollup";
    parsed.password = password;
    return parsed.toString();
  } catch {
    return undefined;
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

  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  const rollupClickhouseUrl = rollupUrl(process.env.CLICKHOUSE_URL);
  const rateLimits = parseRateLimits(process.env);

  return {
    port,
    databaseUrl,
    clickhouseUrl,
    apiKeyHashSecret,
    jwtSecret,
    trustProxy,
    rollupClickhouseUrl,
    rateLimits,
  };
}
