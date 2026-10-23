/**
 * `value` with the keys of every object sorted, at every level, so that
 * `JSON.stringify(stable(value))` is the same string whatever order the
 * keys were written in. A function is reduced to its presence
 * (`"[function]"`); everything else is left to `JSON.stringify`, which
 * throws on a BigInt. Not guarded against cycles: the callers pass a
 * resolved config or an event already walked by `stripPii`, which replaces
 * them. Shared by the proxy's config fingerprint and the fingerprint of the
 * last `identify` event a session state sent (#145).
 */
export function stable(value: unknown): unknown {
  if (typeof value === "function") return "[function]";
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
