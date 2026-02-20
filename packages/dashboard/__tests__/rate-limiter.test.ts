import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../lib/rate-limit/rate-limiter";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter?.stop();
  });

  it("allows requests within limit", () => {
    limiter = new RateLimiter({ ratePerSecond: 10, burstCapacity: 10 });
    const result = limiter.consume("key1");
    expect(result.allowed).toBe(true);
  });

  it("rejects requests exceeding burst capacity", () => {
    limiter = new RateLimiter({ ratePerSecond: 1, burstCapacity: 3 });

    expect(limiter.consume("key1").allowed).toBe(true);
    expect(limiter.consume("key1").allowed).toBe(true);
    expect(limiter.consume("key1").allowed).toBe(true);

    const result = limiter.consume("key1");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it("isolates different keys", () => {
    limiter = new RateLimiter({ ratePerSecond: 1, burstCapacity: 1 });

    expect(limiter.consume("key1").allowed).toBe(true);
    expect(limiter.consume("key1").allowed).toBe(false);
    expect(limiter.consume("key2").allowed).toBe(true);
  });

  it("tracks bucket count", () => {
    limiter = new RateLimiter({ ratePerSecond: 10, burstCapacity: 10 });

    limiter.consume("a");
    limiter.consume("b");
    expect(limiter.bucketCount).toBe(2);
  });

  it("starts and stops cleanup timer", () => {
    limiter = new RateLimiter({ ratePerSecond: 10, burstCapacity: 10 });
    limiter.start();
    limiter.stop();
  });
});
