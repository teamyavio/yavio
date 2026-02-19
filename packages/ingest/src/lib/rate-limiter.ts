/**
 * Token bucket rate limiter.
 *
 * Per-API-key: 1,000 events/sec, 5,000 burst capacity.
 * Per-IP (unauthenticated): 10 req/sec.
 */

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

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

export class RateLimiter {
  private readonly apiKeyBuckets = new Map<string, TokenBucket>();
  private readonly ipBuckets = new Map<string, TokenBucket>();
  private readonly apiKeyConfig: RateLimiterConfig;
  private readonly ipConfig: RateLimiterConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly staleAfterMs: number;

  constructor(apiKeyConfig?: Partial<RateLimiterConfig>, ipConfig?: Partial<RateLimiterConfig>) {
    this.apiKeyConfig = { ...DEFAULT_API_KEY_CONFIG, ...apiKeyConfig };
    this.ipConfig = { ...DEFAULT_IP_CONFIG, ...ipConfig };
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
   * Consume tokens for an IP-based request.
   */
  consumeIp(ip: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    return this.consume(this.ipBuckets, ip, this.ipConfig, 1);
  }

  private consume(
    buckets: Map<string, TokenBucket>,
    key: string,
    config: RateLimiterConfig,
    tokens: number,
  ): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket) {
      bucket = { tokens: config.burstCapacity, lastRefill: now };
      buckets.set(key, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(config.burstCapacity, bucket.tokens + elapsed * config.ratePerSecond);
    bucket.lastRefill = now;

    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return { allowed: true };
    }

    // Not enough tokens — calculate retry time
    const deficit = tokens - bucket.tokens;
    const retryAfterMs = Math.ceil((deficit / config.ratePerSecond) * 1000);
    return { allowed: false, retryAfterMs };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.apiKeyBuckets) {
      if (now - bucket.lastRefill > this.staleAfterMs) {
        this.apiKeyBuckets.delete(key);
      }
    }
    for (const [key, bucket] of this.ipBuckets) {
      if (now - bucket.lastRefill > this.staleAfterMs) {
        this.ipBuckets.delete(key);
      }
    }
  }

  get apiKeyBucketCount(): number {
    return this.apiKeyBuckets.size;
  }

  get ipBucketCount(): number {
    return this.ipBuckets.size;
  }
}
