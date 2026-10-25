/**
 * W3C Trace Context (https://www.w3.org/TR/trace-context/) as MCP carries it
 * (#173): SEP-414 (MCP 2026-07-28) puts `traceparent`, `tracestate` and
 * `baggage` in the request `_meta`; over HTTP a client may also send the
 * `traceparent` header.
 */

/** The SEP-414 `_meta` keys. None of them is ever kept in the `_meta` clone. */
export const TRACE_CONTEXT_META_KEYS: ReadonlySet<string> = new Set([
  "traceparent",
  "tracestate",
  "baggage",
]);

/**
 * `version "-" trace-id "-" parent-id "-" trace-flags`, lower-case hex,
 * exactly 55 characters (§3.2.2). `$` without the `m` flag: no trailing
 * newline either.
 */
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_PARENT_ID = "0".repeat(16);

/**
 * The value if it is a valid `traceparent`, else undefined: the format above,
 * version not `ff` (§3.2.2.1), trace id and parent id not all zeros (§3.2.2.3,
 * §3.2.2.4). Upper-case hex is invalid (§3.2.2). A higher version's extra
 * fields after the 55th character (§3.2.4) are not accepted: no such version
 * exists, and the SDK stores nothing it cannot read.
 *
 * A valid value is 128 + 64 random bits and two bytes of hex: it has no room
 * for personal data, which is why the PII stripper leaves it alone (pii.ts).
 */
export function traceparentOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = TRACEPARENT.exec(value);
  if (!match || match[1] === "ff" || match[2] === ZERO_TRACE_ID || match[3] === ZERO_PARENT_ID) {
    return undefined;
  }
  return value;
}
