import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LruCache } from "../lib/lru-cache.js";

describe("LruCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and retrieves values", () => {
    const cache = new LruCache<string>(10, 60_000);
    cache.set("a", "hello");
    expect(cache.get("a")).toBe("hello");
  });

  it("returns undefined for missing keys", () => {
    const cache = new LruCache<string>(10, 60_000);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("evicts expired entries on get", () => {
    const cache = new LruCache<string>(10, 1_000);
    cache.set("a", "hello");

    vi.advanceTimersByTime(1_001);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the oldest entry when at max size", () => {
    const cache = new LruCache<string>(2, 60_000);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3"); // should evict "a"

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
  });

  it("refreshes position on get (LRU order)", () => {
    const cache = new LruCache<string>(2, 60_000);
    cache.set("a", "1");
    cache.set("b", "2");

    // Access "a" to make it most recently used
    cache.get("a");

    // Insert "c" — should evict "b" (least recently used)
    cache.set("c", "3");

    expect(cache.get("a")).toBe("1");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("3");
  });

  it("overwrites existing keys and resets TTL", () => {
    const cache = new LruCache<string>(10, 2_000);
    cache.set("a", "v1");

    vi.advanceTimersByTime(1_500);
    cache.set("a", "v2");

    vi.advanceTimersByTime(1_500);
    // Should still be valid (TTL reset on overwrite)
    expect(cache.get("a")).toBe("v2");
  });

  it("delete removes an entry", () => {
    const cache = new LruCache<string>(10, 60_000);
    cache.set("a", "hello");
    expect(cache.delete("a")).toBe(true);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("clear removes all entries", () => {
    const cache = new LruCache<string>(10, 60_000);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("stores null values correctly", () => {
    const cache = new LruCache<null>(10, 60_000);
    cache.set("a", null);
    expect(cache.get("a")).toBeNull();
  });
});
