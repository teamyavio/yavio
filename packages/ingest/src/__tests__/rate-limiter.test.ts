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

  describe("auth-failure bucket (#94)", () => {
    it("is separate from the credential-less IP bucket", () => {
      const limiter = new RateLimiter(undefined, { burstCapacity: 1, ratePerSecond: 1 });
      expect(limiter.consumeIp("10.0.0.1").allowed).toBe(true);
      expect(limiter.consumeIp("10.0.0.1").allowed).toBe(false);
      // Exhausting one never touches the other.
      expect(limiter.peekAuthFailure("10.0.0.1").allowed).toBe(true);
      expect(limiter.consumeAuthFailure("10.0.0.1").allowed).toBe(true);
      expect(limiter.peekAuthFailure("10.0.0.1").allowed).toBe(false);
    });

    it("peeks without consuming and refills over time", () => {
      const limiter = new RateLimiter(undefined, { burstCapacity: 1, ratePerSecond: 1 });
      expect(limiter.peekAuthFailure("10.0.0.2").allowed).toBe(true);
      expect(limiter.peekAuthFailure("10.0.0.2").allowed).toBe(true);
      limiter.consumeAuthFailure("10.0.0.2");
      const blocked = limiter.peekAuthFailure("10.0.0.2");
      expect(blocked.allowed).toBe(false);
      if (!blocked.allowed) expect(blocked.retryAfterMs).toBeGreaterThan(0);
      vi.advanceTimersByTime(1_000);
      expect(limiter.peekAuthFailure("10.0.0.2").allowed).toBe(true);
    });

    it("cleans up stale auth-failure buckets", () => {
      const limiter = new RateLimiter({ cleanupIntervalMs: 1_000, staleAfterMs: 500 });
      limiter.consumeAuthFailure("10.0.0.3");
      expect(limiter.authFailureBucketCount).toBe(1);
      limiter.start();
      vi.advanceTimersByTime(1_000);
      expect(limiter.authFailureBucketCount).toBe(0);
      limiter.stop();
    });
  });

  describe("widget-token bucket", () => {
    it("defaults to a 1,000-event burst refilled at 50 events per second", () => {
      const limiter = new RateLimiter();
      expect(limiter.consumeWidgetToken("p:trace-1", 1_000).allowed).toBe(true);
      const denied = limiter.consumeWidgetToken("p:trace-1", 50);
      expect(denied.allowed).toBe(false);
      if (!denied.allowed) expect(denied.retryAfterMs).toBe(1_000);
      vi.advanceTimersByTime(1_000);
      expect(limiter.consumeWidgetToken("p:trace-1", 50).allowed).toBe(true);
      expect(limiter.consumeWidgetToken("p:trace-1", 1).allowed).toBe(false);
    });

    it("takes its limits from the third constructor argument", () => {
      const limiter = new RateLimiter(undefined, undefined, { burstCapacity: 5, ratePerSecond: 1 });
      expect(limiter.consumeWidgetToken("p:trace-1", 5).allowed).toBe(true);
      expect(limiter.consumeWidgetToken("p:trace-1", 1).allowed).toBe(false);
    });

    it("is separate from the API-key buckets", () => {
      const limiter = new RateLimiter({ burstCapacity: 1, ratePerSecond: 1 }, undefined, {
        burstCapacity: 1,
        ratePerSecond: 1,
      });
      expect(limiter.consumeApiKey("p:w", 1).allowed).toBe(true);
      expect(limiter.consumeApiKey("p:w", 1).allowed).toBe(false);
      expect(limiter.consumeWidgetToken("p:w", 1).allowed).toBe(true);
      expect(limiter.consumeWidgetToken("p:w", 1).allowed).toBe(false);
    });

    it("cleans up stale widget-token buckets", () => {
      const limiter = new RateLimiter({ cleanupIntervalMs: 1_000, staleAfterMs: 500 });
      limiter.consumeWidgetToken("p:trace-1", 1);
      expect(limiter.widgetTokenBucketCount).toBe(1);
      limiter.start();
      vi.advanceTimersByTime(1_000);
      expect(limiter.widgetTokenBucketCount).toBe(0);
      limiter.stop();
    });
  });
});
