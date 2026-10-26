/**
 * PII stripping engine.
 *
 * Recursively walks all string values in an object and replaces
 * patterns matching common PII: emails, IBANs, credit cards, SSNs and ITINs,
 * phone numbers, and physical addresses. The string-level rules live in
 * @yavio/shared/pii (#182), shared with the SDK's stripper; this module keeps
 * the walk and the identifier-field exemption.
 */

import { stripPiiString } from "@yavio/shared/pii";

/**
 * Strip PII patterns from a single string value with ingest's rules (dashed,
 * spaced and bare SSNs, ITINs, street addresses on top of the SDK's). A
 * string that is exactly a valid traceparent is returned unchanged, not
 * redacted.
 */
export function stripPiiFromString(value: string): { result: string; redacted: boolean } {
  return stripPiiString(value, "ingest");
}

/**
 * Event fields that hold identifiers or validated formats, never user content.
 *
 * The patterns must not run over them: a random UUID or a hex session hash
 * that happens to contain a digit run was rewritten (an event_id ending in
 * -959114949231 was stored as -95[PHONE_REDACTED]), which corrupts the id,
 * breaks joins on trace/session, and can make two events collide on one
 * event_id. `user_id` is not listed: integrators choose it, and some use an
 * email address.
 */
export const EVENT_IDENTIFIER_FIELDS: ReadonlySet<string> = new Set([
  "event_id",
  "trace_id",
  "session_id",
  "subject_id",
  "timestamp",
]);

/**
 * Levels of objects and arrays the PII walk descends: a container deeper
 * than this is replaced with PII_DEPTH_MARKER instead of being walked, so
 * the walk's recursion stays bounded and nothing deeper is stored unscanned.
 * The events route refuses bodies nested beyond MAX_BODY_NESTING
 * (lib/nesting.ts), which is below this, so there it never applies.
 */
export const MAX_PII_WALK_DEPTH = 64;

/** What a container past MAX_PII_WALK_DEPTH is replaced with. */
export const PII_DEPTH_MARKER = "[DEPTH_LIMIT]";

export interface StripPiiOptions {
  /** Keys left untouched on each object directly inside the top-level array. */
  exemptEventKeys?: ReadonlySet<string>;
}

/**
 * Recursively strip PII from all string values in an object.
 * Returns a new object (does not mutate the original).
 */
export function stripPii<T>(
  data: T,
  options: StripPiiOptions = {},
): { result: T; piiDetected: boolean } {
  let piiDetected = false;
  const exempt = options.exemptEventKeys;

  function walk(value: unknown, depth: number): unknown {
    if (typeof value === "string") {
      const { result, redacted } = stripPiiFromString(value);
      if (redacted) piiDetected = true;
      return result;
    }

    if (value !== null && typeof value === "object" && depth >= MAX_PII_WALK_DEPTH) {
      return PII_DEPTH_MARKER;
    }

    if (Array.isArray(value)) {
      return value.map((item) => walk(item, depth + 1));
    }

    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        // depth 1: an event inside the top-level batch array.
        result[key] = exempt && depth === 1 && exempt.has(key) ? val : walk(val, depth + 1);
      }
      return result;
    }

    return value;
  }

  const result = walk(data, 0) as T;
  return { result, piiDetected };
}
