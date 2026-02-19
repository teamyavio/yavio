import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimiter } from "../lib/rate-limiter.js";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("consumeApiKey", () => {
    it("allows requests within burst capacity", () => {
      const limiter = new RateLimiter({ burstCapacity: 100, ratePerSecond: 10 });
      const result = limiter.consumeApiKey("key-1", 50);
      expect(result.allowed).toBe(true);
    });

    it("denies requests that exceed burst capacity", () => {
      const limiter = new RateLimiter({ burstCapacity: 10, ratePerSecond: 5 });
      const result = limiter.consumeApiKey("key-1", 11);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.retryAfterMs).toBeGreaterThan(0);
      }
    });

    it("refills tokens over time", () => {
      const limiter = new RateLimiter({ burstCapacity: 10, ratePerSecond: 10 });

      // Consume all tokens
      limiter.consumeApiKey("key-1", 10);
      const denied = limiter.consumeApiKey("key-1", 1);
      expect(denied.allowed).toBe(false);

      // Wait 1 second — should refill 10 tokens
      vi.advanceTimersByTime(1_000);
      const allowed = limiter.consumeApiKey("key-1", 5);
      expect(allowed.allowed).toBe(true);
    });

    it("tracks separate keys independently", () => {
      const limiter = new RateLimiter({ burstCapacity: 5, ratePerSecond: 5 });

      limiter.consumeApiKey("key-1", 5);
      const r1 = limiter.consumeApiKey("key-1", 1);
      expect(r1.allowed).toBe(false);

      const r2 = limiter.consumeApiKey("key-2", 1);
      expect(r2.allowed).toBe(true);
    });

    it("does not exceed burst capacity on refill", () => {
      const limiter = new RateLimiter({ burstCapacity: 10, ratePerSecond: 100 });

      // Wait a long time
      vi.advanceTimersByTime(60_000);

      // Should cap at burstCapacity, not 6000
      const result = limiter.consumeApiKey("key-1", 10);
      expect(result.allowed).toBe(true);
      const denied = limiter.consumeApiKey("key-1", 1);
      expect(denied.allowed).toBe(false);
    });
  });

  describe("consumeIp", () => {
    it("allows requests within limit", () => {
      const limiter = new RateLimiter(undefined, { burstCapacity: 20, ratePerSecond: 10 });
      const result = limiter.consumeIp("192.168.1.1");
      expect(result.allowed).toBe(true);
    });

    it("denies after exceeding burst", () => {
      const limiter = new RateLimiter(undefined, { burstCapacity: 2, ratePerSecond: 1 });
      limiter.consumeIp("192.168.1.1");
      limiter.consumeIp("192.168.1.1");
      const result = limiter.consumeIp("192.168.1.1");
      expect(result.allowed).toBe(false);
    });
  });

  describe("cleanup", () => {
    it("removes stale buckets during cleanup", () => {
      const limiter = new RateLimiter(
        { burstCapacity: 10, ratePerSecond: 10, cleanupIntervalMs: 1_000, staleAfterMs: 5_000 },
        { burstCapacity: 10, ratePerSecond: 10, staleAfterMs: 5_000 },
      );

      limiter.start();
      limiter.consumeApiKey("key-1", 1);
      limiter.consumeIp("1.2.3.4");
      expect(limiter.apiKeyBucketCount).toBe(1);
      expect(limiter.ipBucketCount).toBe(1);

      // Advance past stale threshold + cleanup interval
      vi.advanceTimersByTime(6_000);

      expect(limiter.apiKeyBucketCount).toBe(0);
      expect(limiter.ipBucketCount).toBe(0);

      limiter.stop();
    });
  });

  describe("start/stop", () => {
    it("start is idempotent", () => {
      const limiter = new RateLimiter();
      limiter.start();
      limiter.start();
      limiter.stop();
    });

    it("stop is safe without start", () => {
      const limiter = new RateLimiter();
      limiter.stop(); // should not throw
    });
  });
});
