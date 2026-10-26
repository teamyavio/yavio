import { isIP } from "node:net";
import { ErrorCode, YavioError } from "@yavio/shared/errors";
import { MIN_WIDGET_BURST } from "./lib/body-limits.js";
import type { RateLimiterConfig } from "./lib/rate-limiter.js";

const WIDGET_FLOOR_REASON = "a batch of 1,000 events, and a JSON body without a Content-Length";

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
  /** REQUEST_TIMEOUT_MS; undefined keeps the default. */
  requestTimeoutMs: number | undefined;
}

type Limit = Partial<Pick<RateLimiterConfig, "burstCapacity" | "ratePerSecond">>;

export interface RateLimitOverrides {
  widgetToken?: Limit;
  widgetAddress?: Limit;
  widgetProject?: Limit;
  beacon?: Limit;
}

/**
 * The RATE_LIMIT_<name>_BURST / _PER_SECOND pairs, what they configure, and
 * the smallest burst each accepts: a widget bucket must hold one full
 * request (MIN_WIDGET_BURST), a beacon bucket one beacon.
 */
const RATE_LIMIT_VARS: Array<[keyof RateLimitOverrides, string, number, string]> = [
  ["widgetToken", "RATE_LIMIT_WIDGET_TOKEN", MIN_WIDGET_BURST, WIDGET_FLOOR_REASON],
  ["widgetAddress", "RATE_LIMIT_WIDGET_ADDRESS", MIN_WIDGET_BURST, WIDGET_FLOOR_REASON],
  ["widgetProject", "RATE_LIMIT_WIDGET_PROJECT", MIN_WIDGET_BURST, WIDGET_FLOOR_REASON],
  ["beacon", "RATE_LIMIT_BEACON", 1, "one beacon"],
];

function invalid(variable: string, message: string): YavioError {
  return new YavioError(ErrorCode.INFRA.INVALID_ENV_VAR, `${variable} ${message}`, 500, {
    variable,
  });
}

function positiveNumber(variable: string, raw: string): number {
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || value <= 0) {
    throw invalid(variable, `must be a positive number, got "${raw}"`);
  }
  return value;
}

/** A whole number of at least `floor`; `reason` says what the floor holds. */
function wholeNumber(variable: string, raw: string, floor: number, reason: string): number {
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(value) || value < floor) {
    throw invalid(
      variable,
      `must be a whole number of at least ${floor} (${reason}), got "${raw}"`,
    );
  }
  return value;
}

/**
 * Rate limits from RATE_LIMIT_<name>_BURST and RATE_LIMIT_<name>_PER_SECOND
 * (the bucket's capacity, and what it refills per second). Unset or empty
 * keeps the default (lib/rate-limiter.ts). A burst must be a whole number
 * that holds one full request; a rate any positive number. Anything else
 * stops the start.
 */
export function parseRateLimits(env: NodeJS.ProcessEnv): RateLimitOverrides {
  const overrides: RateLimitOverrides = {};
  for (const [name, prefix, floor, reason] of RATE_LIMIT_VARS) {
    const limit: Limit = {};
    const rawBurst = env[`${prefix}_BURST`];
    const rawRate = env[`${prefix}_PER_SECOND`];
    if (rawBurst !== undefined && rawBurst !== "") {
      limit.burstCapacity = wholeNumber(`${prefix}_BURST`, rawBurst, floor, reason);
    }
    if (rawRate !== undefined && rawRate !== "") {
      limit.ratePerSecond = positiveNumber(`${prefix}_PER_SECOND`, rawRate);
    }
    if (Object.keys(limit).length > 0) overrides[name] = limit;
  }
  return overrides;
}

/**
 * REQUEST_TIMEOUT_MS: how long a client has to send a whole request
 * (index.ts). Unset or empty keeps DEFAULT_REQUEST_TIMEOUT_MS; anything but
 * a whole number of at least 1,000 stops the start.
 */
export function parseRequestTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  return wholeNumber("REQUEST_TIMEOUT_MS", raw, 1_000, "one second");
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
  const requestTimeoutMs = parseRequestTimeout(process.env.REQUEST_TIMEOUT_MS);

  return {
    port,
    databaseUrl,
    clickhouseUrl,
    apiKeyHashSecret,
    jwtSecret,
    trustProxy,
    rollupClickhouseUrl,
    rateLimits,
    requestTimeoutMs,
  };
}
