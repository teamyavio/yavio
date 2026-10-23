import { describe, expect, it } from "vitest";
import { stable } from "../core/stable.js";

const json = (value: unknown) => JSON.stringify(stable(value));

describe("stable", () => {
  it("sorts the keys of every object, at every level", () => {
    expect(json({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(json({ a: { c: 3, d: 2 }, b: 1 })).toBe(json({ b: 1, a: { d: 2, c: 3 } }));
  });

  it("keeps the order of arrays and sorts the objects inside them", () => {
    expect(json([{ b: 1, a: 2 }, 3])).toBe('[{"a":2,"b":1},3]');
    expect(json([1, 2])).not.toBe(json([2, 1]));
  });

  it("reduces a function to its presence and leaves a BigInt to JSON.stringify, which throws", () => {
    expect(json({ fallback: () => "x" })).toBe('{"fallback":"[function]"}');
    expect(() => json({ n: 1n })).toThrow(TypeError);
  });
});
