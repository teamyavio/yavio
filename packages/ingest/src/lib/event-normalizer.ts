import type { BaseEvent } from "@yavio/shared/events";
import { COUNTRY_CODES, CURRENCY_CODES } from "./iso-codes.js";

/**
 * Normalisation of client-supplied fields before PII stripping and enrichment
 * (#90). Whatever slips through here would also reach the anonymous statistics
 * kept indefinitely (#85), so it is fixed at the door. Nothing here rejects an
 * event: a rejected event is dropped with only a warning in the integrator's
 * own server log, so a client with a skewed clock or an odd locale would lose
 * its data and nobody would notice.
 */

/** How far a client timestamp may lie in the past before it is clamped. */
export const MAX_PAST_MS = 72 * 60 * 60 * 1000;
/** How far a client timestamp may lie in the future before it is clamped. */
export const MAX_FUTURE_MS = 5 * 60 * 1000;

export interface NormalizeResult {
  events: BaseEvent[];
  /** Events whose timestamp was moved into [now - 72 h, now + 5 min]. */
  clampedTimestamps: number;
  /** Format-checked fields set to NULL because the value was not valid. */
  invalidFields: number;
}

/**
 * - `timestamp` is clamped to [now - 72 h, now + 5 min]. A future-dated event
 *   would otherwise escape retention and pollute day/hour buckets; the #85
 *   TTL additionally uses least(timestamp, ingested_at).
 * - `country_code`: ISO 3166-1 alpha-2 or XK, upper-cased; else NULL.
 * - `conversion_currency`: ISO 4217, upper-cased; else NULL.
 * - `locale`: a BCP-47 tag in canonical form (Intl.getCanonicalLocales); else NULL.
 */
export function normalizeEvents(events: BaseEvent[], now = Date.now()): NormalizeResult {
  let clampedTimestamps = 0;
  let invalidFields = 0;

  const normalized = events.map((event) => {
    const out: Record<string, unknown> = { ...event };

    const time = Date.parse(event.timestamp);
    const clamped = Math.min(Math.max(time, now - MAX_PAST_MS), now + MAX_FUTURE_MS);
    if (clamped !== time) {
      out.timestamp = new Date(clamped).toISOString();
      clampedTimestamps++;
    }

    const checks: Array<[string, (value: string) => string | null]> = [
      ["country_code", (v) => (COUNTRY_CODES.has(v.toUpperCase()) ? v.toUpperCase() : null)],
      [
        "conversion_currency",
        (v) => (CURRENCY_CODES.has(v.toUpperCase()) ? v.toUpperCase() : null),
      ],
      ["locale", canonicalLocale],
    ];
    for (const [field, check] of checks) {
      const value = out[field];
      if (value === undefined || value === null) continue;
      const valid = typeof value === "string" ? check(value) : null;
      if (valid === null) invalidFields++;
      out[field] = valid;
    }

    return out as BaseEvent;
  });

  return { events: normalized, clampedTimestamps, invalidFields };
}

function canonicalLocale(value: string): string | null {
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    return canonical ?? null;
  } catch {
    // RangeError: not a structurally valid BCP-47 tag.
    return null;
  }
}
