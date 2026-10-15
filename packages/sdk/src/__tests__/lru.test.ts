import { describe, expect, it, vi } from "vitest";
import { LruMap } from "../core/lru.js";

describe("LruMap", () => {
  it("evicts the least recently used entry once over capacity", () => {
    const onEvict = vi.fn();
    const lru = new LruMap<string, number>(2, onEvict);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    expect([...lru.keys()]).toEqual(["b", "c"]);
    expect(onEvict).toHaveBeenCalledWith("a", 1);
  });

  it("a get counts as use, has and peek do not", () => {
    const lru = new LruMap<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.get("a")).toBe(1);
    lru.set("c", 3); // b is now the oldest
    expect(lru.has("b")).toBe(false);
    expect([...lru.keys()]).toEqual(["a", "c"]);

    lru.has("a");
    lru.peek("a");
    lru.set("d", 4); // a is still the oldest
    expect([...lru.keys()]).toEqual(["c", "d"]);
  });

  it("re-setting a key refreshes it without growing", () => {
    const lru = new LruMap<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("a", 10);
    expect(lru.size).toBe(2);
    expect([...lru.keys()]).toEqual(["b", "a"]);
    expect(lru.peek("a")).toBe(10);
  });

  it("delete, clear and a miss", () => {
    const lru = new LruMap<string, number>(3);
    lru.set("a", 1);
    expect(lru.delete("a")).toBe(true);
    expect(lru.delete("a")).toBe(false);
    expect(lru.get("a")).toBeUndefined();
    lru.set("b", 2);
    lru.clear();
    expect(lru.size).toBe(0);
  });

  it("rejects a capacity that is not a positive integer", () => {
    expect(() => new LruMap(0)).toThrow(RangeError);
    expect(() => new LruMap(1.5)).toThrow(RangeError);
  });
});
