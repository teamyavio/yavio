/**
 * Token bucket rate limiter.
 *
 * Per-API-key (keyed per project): 1,000 events/sec, 5,000 burst capacity,
 * charged by event count (plugins/events.ts).
 * Widget-token requests are charged in units (one per event, or one per KiB
 * of body when that is more, plugins/rate-limit.ts widgetUnits) to three
 * buckets at once, all or none:
 *   - per token (the JWT's `pid` and `tid`): 50 units/sec, burst 1,000. A
 *     batch at the cap fits; a widget (at most 20 events per batch, 200 in a
 *     teardown beacon) stays far below it;
 *   - per client address (IPv6 by /64), only with TRUST_PROXY: 200 units/sec,
 *     burst 2,000;
 *   - per project, separate from its API-key bucket: 1,000 units/sec, burst
 *     10,000, the ceiling for all of a project's widgets together.
 * Per-IP, two separate buckets of 10 req/sec, burst 20 (plugins/rate-limit.ts):
 *   - requests that carry no credential at all;
 *   - requests that carry one and fail authentication.
 * Authenticated traffic is bounded by the per-key or widget buckets instead (#94).
 *
 * Each scope's limits are a constructor argument over these defaults.
 */

interface TokenBucket {
  tokens: number;
  lastRefill: number;
  /** When a refusal of this bucket was last reported (widget project ceiling). */
  warnedAt?: number;
}

/** Which widget bucket refused a request. */
export type WidgetLimit = "token" | "address" | "project";

/** The keys of the widget buckets one request is charged to. */
export interface WidgetBucketKeys {
  token: string;
  /** Absent without TRUST_PROXY: the address may be a proxy's. */
  address?: string;
  project: string;
}

/** A project's widget ceiling is reported at most this often. */
const WIDGET_PROJECT_WARN_INTERVAL_MS = 60_000;

export interface RateLimiterConfig {
  /** Max sustained rate (tokens added per second). */
  ratePerSecond: number;
  /** Max burst capacity. */
  burstCapacity: number;
  /** Interval in ms to clean up stale buckets. */
  cleanupIntervalMs?: number;
  /** How long (ms) before a bucket is considered stale. */
  staleAfterMs?: number;
}

const DEFAULT_API_KEY_CONFIG: RateLimiterConfig = {
  ratePerSecond: 1_000,
  burstCapacity: 5_000,
};

const DEFAULT_IP_CONFIG: RateLimiterConfig = {
  ratePerSecond: 10,
  burstCapacity: 20,
};

const DEFAULT_WIDGET_TOKEN_CONFIG: RateLimiterConfig = {
  ratePerSecond: 50,
  burstCapacity: 1_000,
};

const DEFAULT_WIDGET_ADDRESS_CONFIG: RateLimiterConfig = {
  ratePerSecond: 200,
  burstCapacity: 2_000,
};

const DEFAULT_WIDGET_PROJECT_CONFIG: RateLimiterConfig = {
  ratePerSecond: 1_000,
  burstCapacity: 10_000,
};

export class RateLimiter {
  private readonly apiKeyBuckets = new Map<string, TokenBucket>();
  private readonly ipBuckets = new Map<string, TokenBucket>();
  private readonly authFailureBuckets = new Map<string, TokenBucket>();
  private readonly widgetTokenBuckets = new Map<string, TokenBucket>();
  private readonly widgetAddressBuckets = new Map<string, TokenBucket>();
  private readonly widgetProjectBuckets = new Map<string, TokenBucket>();
  private readonly apiKeyConfig: RateLimiterConfig;
  private readonly ipConfig: RateLimiterConfig;
  private readonly widgetTokenConfig: RateLimiterConfig;
  private readonly widgetAddressConfig: RateLimiterConfig;
  private readonly widgetProjectConfig: RateLimiterConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly staleAfterMs: number;

  constructor(
    apiKeyConfig?: Partial<RateLimiterConfig>,
    ipConfig?: Partial<RateLimiterConfig>,
    widgetTokenConfig?: Partial<RateLimiterConfig>,
    widgetAddressConfig?: Partial<RateLimiterConfig>,
    widgetProjectConfig?: Partial<RateLimiterConfig>,
  ) {
    this.apiKeyConfig = { ...DEFAULT_API_KEY_CONFIG, ...apiKeyConfig };
    this.ipConfig = { ...DEFAULT_IP_CONFIG, ...ipConfig };
    this.widgetTokenConfig = { ...DEFAULT_WIDGET_TOKEN_CONFIG, ...widgetTokenConfig };
    this.widgetAddressConfig = { ...DEFAULT_WIDGET_ADDRESS_CONFIG, ...widgetAddressConfig };
    this.widgetProjectConfig = { ...DEFAULT_WIDGET_PROJECT_CONFIG, ...widgetProjectConfig };
    this.staleAfterMs = apiKeyConfig?.staleAfterMs ?? 60_000;
  }

  /**
   * Start periodic cleanup of stale buckets.
   */
  start(): void {
    if (this.cleanupTimer) return;
    const interval = this.apiKeyConfig.cleanupIntervalMs ?? 60_000;
    this.cleanupTimer = setInterval(() => this.cleanup(), interval);
  }

  /**
   * Stop the cleanup timer.
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Consume tokens for an API key request.
   * Returns `{ allowed: true }` or `{ allowed: false, retryAfterMs }`.
   */
  consumeApiKey(
    key: string,
    tokens = 1,
  ): { allowed: true } | { allowed: false; retryAfterMs: number } {
    return this.consume(this.apiKeyBuckets, key, this.apiKeyConfig, tokens);
  }

  /**
   * Consume tokens for a widget-token (JWT) request, keyed per token: the
   * project and the token's trace. Separate from the API-key buckets, so
   * widget traffic never draws on a project's server-side budget.
   */
  consumeWidgetToken(
    key: string,
    tokens = 1,
  ): { allowed: true } | { allowed: false; retryAfterMs: number } {
    return this.consume(this.widgetTokenBuckets, key, this.widgetTokenConfig, tokens);
  }

  /**
   * Charge a widget-token request `units` to its token's, its address's
   * (when given) and its project's widget buckets: all of them or none, so a
   * refused request costs nothing. A refusal names the first bucket short,
   * in that order, and waits for the slowest of those short. `warn` is set
   * on a refusal by the project bucket at most once a minute per project,
   * for the caller to log.
   */
  consumeWidget(
    keys: WidgetBucketKeys,
    units: number,
  ):
    | { allowed: true }
    | { allowed: false; retryAfterMs: number; limit: WidgetLimit; warn: boolean } {
    const now = Date.now();
    const charges: Array<[WidgetLimit, TokenBucket, RateLimiterConfig]> = [
      [
        "token",
        this.bucket(this.widgetTokenBuckets, keys.token, this.widgetTokenConfig, now),
        this.widgetTokenConfig,
      ],
    ];
    if (keys.address !== undefined) {
      const bucket = this.bucket(
        this.widgetAddressBuckets,
        keys.address,
        this.widgetAddressConfig,
        now,
      );
      charges.push(["address", bucket, this.widgetAddressConfig]);
    }
    charges.push([
      "project",
      this.bucket(this.widgetProjectBuckets, keys.project, this.widgetProjectConfig, now),
      this.widgetProjectConfig,
    ]);

    const short = charges.filter(([, bucket]) => bucket.tokens < units);
    if (short.length === 0) {
      for (const [, bucket] of charges) bucket.tokens -= units;
      return { allowed: true };
    }

    const retryAfterMs = Math.max(
      ...short.map(([, bucket, config]) =>
        Math.ceil(((units - bucket.tokens) / config.ratePerSecond) * 1000),
      ),
    );
    const [limit] = short[0];
    let warn = false;
    const project = short.find(([name]) => name === "project")?.[1];
    if (
      project &&
      (project.warnedAt === undefined || now - project.warnedAt >= WIDGET_PROJECT_WARN_INTERVAL_MS)
    ) {
      project.warnedAt = now;
      warn = true;
    }
    return { allowed: false, retryAfterMs, limit, warn };
  }

  /**
   * Consume tokens for an IP-based request.
   */
  consumeIp(ip: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    return this.consume(this.ipBuckets, ip, this.ipConfig, 1);
  }

  /**
   * Charge an address for a request that carried a credential and failed to
   * authenticate. Separate from consumeIp, so credential-less traffic (scanners)
   * can never throttle authenticated clients sharing that address.
   */
  consumeAuthFailure(ip: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    return this.consume(this.authFailureBuckets, ip, this.ipConfig, 1);
  }

  /**
   * Give back one auth-failure token charged on arrival to a request that
   * then authenticated (a widget beacon, plugins/rate-limit.ts).
   */
  refundAuthFailure(ip: string): void {
    const bucket = this.authFailureBuckets.get(ip);
    if (!bucket) return;
    const now = Date.now();
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(
      this.ipConfig.burstCapacity,
      bucket.tokens + elapsed * this.ipConfig.ratePerSecond + 1,
    );
    bucket.lastRefill = now;
  }

  /**
   * Whether the address still has auth-failure budget, without consuming it.
   * Credentialed requests are refused only once this is exhausted.
   */
  peekAuthFailure(ip: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const bucket = this.authFailureBuckets.get(ip);
    if (!bucket) return { allowed: true };
    const elapsed = (Date.now() - bucket.lastRefill) / 1000;
    const tokens = Math.min(
      this.ipConfig.burstCapacity,
      bucket.tokens + elapsed * this.ipConfig.ratePerSecond,
    );
    if (tokens >= 1) return { allowed: true };
    return {
      allowed: false,
      retryAfterMs: Math.ceil(((1 - tokens) / this.ipConfig.ratePerSecond) * 1000),
    };
  }

  private consume(
    buckets: Map<string, TokenBucket>,
    key: string,
    config: RateLimiterConfig,
    tokens: number,
  ): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const bucket = this.bucket(buckets, key, config, Date.now());

    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return { allowed: true };
    }

    // Not enough tokens — calculate retry time
    const deficit = tokens - bucket.tokens;
    const retryAfterMs = Math.ceil((deficit / config.ratePerSecond) * 1000);
    return { allowed: false, retryAfterMs };
  }

  /** The bucket for `key`, created full, refilled for the time since it was last touched. */
  private bucket(
    buckets: Map<string, TokenBucket>,
    key: string,
    config: RateLimiterConfig,
    now: number,
  ): TokenBucket {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: config.burstCapacity, lastRefill: now };
      buckets.set(key, bucket);
    }
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(config.burstCapacity, bucket.tokens + elapsed * config.ratePerSecond);
    bucket.lastRefill = now;
    return bucket;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.apiKeyBuckets) {
      if (now - bucket.lastRefill > this.staleAfterMs) {
        this.apiKeyBuckets.delete(key);
      }
    }
    for (const buckets of [
      this.ipBuckets,
      this.authFailureBuckets,
      this.widgetTokenBuckets,
      this.widgetAddressBuckets,
      this.widgetProjectBuckets,
    ]) {
      for (const [key, bucket] of buckets) {
        if (now - bucket.lastRefill > this.staleAfterMs) {
          buckets.delete(key);
        }
      }
    }
  }

  get apiKeyBucketCount(): number {
    return this.apiKeyBuckets.size;
  }

  get ipBucketCount(): number {
    return this.ipBuckets.size;
  }

  get authFailureBucketCount(): number {
    return this.authFailureBuckets.size;
  }

  get widgetTokenBucketCount(): number {
    return this.widgetTokenBuckets.size;
  }

  get widgetAddressBucketCount(): number {
    return this.widgetAddressBuckets.size;
  }

  get widgetProjectBucketCount(): number {
    return this.widgetProjectBuckets.size;
  }
}
