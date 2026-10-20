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
/** Longest region name kept, in UTF-16 code units; the SDK drops longer ones too (#127). */
export const MAX_REGION_LENGTH = 64;

/**
 * A region name: letters (and combining marks), spaces and the punctuation
 * real subdivision names use — hyphen, both apostrophes, period, comma,
 * parentheses. No digits, `@` or control characters, so nothing that
 * stripPii, which runs after this, could take for an email or a phone number.
 */
const REGION_CHARS = /^[\p{L}\p{M} '\u2019.,()-]+$/u;

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
 * - `region` (#128): a name per regionName(), and only next to a valid
 *   `country_code` — a region without its country says nothing; else NULL.
 *   Stored as sent ("State of Berlin"), not mapped to ISO 3166-2.
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

    // After the loop: the region needs the country as checked above.
    if (out.region !== undefined && out.region !== null) {
      const valid =
        typeof out.region === "string" && typeof out.country_code === "string"
          ? regionName(out.region)
          : null;
      if (valid === null) invalidFields++;
      out.region = valid;
    }

    return out as BaseEvent;
  });

  return { events: normalized, clampedTimestamps, invalidFields };
}

/**
 * The region name in NFC with runs of spaces collapsed and the ends trimmed,
 * or null: empty, longer than MAX_REGION_LENGTH, without a letter, or with a
 * character outside REGION_CHARS. NFC first, so an accent sent decomposed
 * ("u" + U+0308) is kept as the one letter it is. Only space separators are
 * collapsed; a tab or line break is a control character and fails the check.
 */
function regionName(value: string): string | null {
  const name = value
    .normalize("NFC")
    .replace(/\p{Zs}+/gu, " ")
    .replace(/^ | $/g, "");
  if (name.length === 0 || name.length > MAX_REGION_LENGTH) return null;
  return REGION_CHARS.test(name) && /\p{L}/u.test(name) ? name : null;
}

/**
 * The canonical BCP-47 form, or null. The POSIX spelling is the most common
 * non-BCP-47 locale clients send — en_US, and straight from LANG/LC_ALL
 * en_US.UTF-8 or de_DE@euro — so it is normalised rather than dropped (#111):
 * a dropped locale is gone for good in the statistics (the geo slice's
 * language). The codeset and modifier carry no language; the C and POSIX
 * locales name none ("posix" would canonicalise to a bogus language tag).
 */
function canonicalLocale(value: string): string | null {
  const [tag] = value.split(/[.@]/);
  if (tag === "C" || tag === "POSIX") return null;
  try {
    const [canonical] = Intl.getCanonicalLocales(tag.replaceAll("_", "-"));
    return canonical ?? null;
  } catch {
    // RangeError: not a structurally valid BCP-47 tag.
    return null;
  }
}
