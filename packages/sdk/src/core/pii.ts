/**
 * Client-side best-effort PII stripping.
 *
 * Recursively walks all string values and replaces patterns matching
 * common PII: emails, IBANs, credit cards, SSNs, phone numbers. The
 * string-level rules live in @yavio/shared/pii (#182), shared with the
 * ingestion API's authoritative stripper and bundled into this package, so
 * the published SDK gains no dependency. Not configurable. Defense-in-depth
 * layer (the ingestion API strips again).
 */

import { stripPiiString } from "@yavio/shared/pii";

/** Recursively strip PII from all string values. Returns a new object. */
export function stripPii<T>(data: T): T {
  const seen = new WeakSet();

  function walk(value: unknown): unknown {
    if (typeof value === "string") {
      // The SDK's rules: dashed SSNs only, no ITIN or address pattern. A
      // string that is exactly a valid traceparent comes back unchanged.
      return stripPiiString(value, "sdk").result;
    }
    if (value !== null && typeof value === "object") {
      if (seen.has(value as object)) return "[Circular]";
      seen.add(value as object);

      if (Array.isArray(value)) {
        return value.map(walk);
      }
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        result[key] = walk(val);
      }
      return result;
    }
    return value;
  }

  return walk(data) as T;
}
