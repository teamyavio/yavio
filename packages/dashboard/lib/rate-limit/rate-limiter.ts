interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitConfig {
  ratePerSecond: number;
  burstCapacity: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly config: RateLimitConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: RateLimitConfig) {
    this.config = config;
  }

  start(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  consume(key: string, tokens = 1): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: this.config.burstCapacity, lastRefill: now };
      this.buckets.set(key, bucket);
    }

    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(
      this.config.burstCapacity,
      bucket.tokens + elapsed * this.config.ratePerSecond,
    );
    bucket.lastRefill = now;

    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return { allowed: true };
    }

    const deficit = tokens - bucket.tokens;
    const retryAfterMs = Math.ceil((deficit / this.config.ratePerSecond) * 1000);
    return { allowed: false, retryAfterMs };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > 60_000) {
        this.buckets.delete(key);
      }
    }
  }

  get bucketCount(): number {
    return this.buckets.size;
  }
}
