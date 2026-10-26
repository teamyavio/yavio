/**
 * W3C Trace Context (https://www.w3.org/TR/trace-context/) as MCP carries it
 * (#173): SEP-414 (MCP 2026-07-28) puts `traceparent`, `tracestate` and
 * `baggage` in the request `_meta`; over HTTP a client may also send the
 * `traceparent` header.
 */

import { isTraceparent } from "@yavio/shared/pii";

/**
 * The trace-context `_meta` keys, lower-cased:
 * - SEP-414's three;
 * - `correlation-context`, under which .NET 8/9's default propagator
 *   (`LegacyPropagator`, used by the C# MCP SDK through
 *   `DistributedContextPropagator.Current`) writes baggage;
 * - `_dd_trace_context`, the object into which Datadog's MCP instrumentation
 *   (dd-trace-js and dd-trace-py, on by default) injects its whole text map:
 *   its ids, `x-datadog-tags` (which can carry `_dd.p.usr.id`, a base64 user
 *   id) and, with the default inject styles, `traceparent`, `tracestate` and
 *   `baggage` (review round 2).
 *
 * Matched in any letter case. None of them is ever kept in the `_meta` clone;
 * only the exact key `traceparent` is lifted, else Datadog's nested one
 * (extractClientMeta, datadogTraceparent).
 */
const TRACE_CONTEXT_META_KEYS: ReadonlySet<string> = new Set([
  "traceparent",
  "tracestate",
  "baggage",
  "correlation-context",
  "_dd_trace_context",
]);

/**
 * Per-key baggage carriers, lower-cased: Jaeger's `uberctx-<member>` and
 * OpenTracing's `ot-baggage-<member>`. One baggage member per key, its name
 * in the key (`uberctx-user.id`).
 */
const BAGGAGE_KEY_PREFIXES = ["uberctx-", "ot-baggage-"] as const;

/**
 * What a `_meta` key is to the trace-context rules (review round 1 of #173):
 * `"named"` — one of TRACE_CONTEXT_META_KEYS in any letter case, dropped
 * and its name recorded as sent: a fixed name, never data, so also
 * `_dd_trace_context`, whose leading `_` recordable() would refuse (a valid
 * lower-case `traceparent` is moved instead);
 * `"counted"` — a per-key baggage carrier, dropped and only counted, because
 * its name embeds the baggage member's; `undefined` — any other key.
 */
export function traceContextKey(key: string): "named" | "counted" | undefined {
  const lower = key.toLowerCase();
  if (TRACE_CONTEXT_META_KEYS.has(lower)) return "named";
  if (BAGGAGE_KEY_PREFIXES.some((prefix) => lower.startsWith(prefix))) return "counted";
  return undefined;
}

/**
 * A valid `traceparent` inside Datadog's `_meta._dd_trace_context` (exactly
 * these keys, as dd-trace writes them), or undefined: the last source after
 * `_meta.traceparent` and the HTTP header (review round 2). Never throws.
 */
export function datadogTraceparent(meta: Record<string, unknown> | undefined): string | undefined {
  try {
    const context = meta?._dd_trace_context;
    if (!context || typeof context !== "object" || Array.isArray(context)) return undefined;
    return traceparentOf((context as Record<string, unknown>).traceparent);
  } catch {
    return undefined;
  }
}

/**
 * The value if it is a valid `traceparent`, else undefined:
 * `version "-" trace-id "-" parent-id "-" trace-flags`, lower-case hex,
 * exactly 55 characters (§3.2.2), no trailing newline, version not `ff`
 * (§3.2.2.1), trace id and parent id not all zeros (§3.2.2.3, §3.2.2.4).
 * Upper-case hex is invalid (§3.2.2). A higher version's extra fields after
 * the 55th character (§3.2.4) are not accepted: no such version exists, and
 * the SDK stores nothing it cannot read.
 *
 * The check is `isTraceparent()` from @yavio/shared/pii (#182), the one both
 * PII strippers use: a valid value is 128 + 64 random bits and two bytes of
 * hex, with no room for personal data, so they leave it alone.
 */
export function traceparentOf(value: unknown): string | undefined {
  return typeof value === "string" && isTraceparent(value) ? value : undefined;
}
