import { type BaseEvent, SESSION_SOURCES } from "@yavio/shared/events";
import { normalizeRegionName } from "@yavio/shared/geo";
import { COUNTRY_CODES, CURRENCY_CODES } from "./iso-codes.js";

const KNOWN_SESSION_SOURCES: ReadonlySet<string> = new Set(SESSION_SOURCES);

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
 *   TTL additionally uses least(timestamp, ingested_at). It is always written
 *   as an ISO string with milliseconds (`toISOString`), the precision of the
 *   column (DateTime64(3)) — and of tool_registry.registered_at, which is
 *   taken from it.
 * - `country_code`: ISO 3166-1 alpha-2 or XK, upper-cased; else NULL.
 * - `conversion_currency`: ISO 4217, upper-cased; else NULL.
 * - `locale`: a BCP-47 tag in canonical form (Intl.getCanonicalLocales); else NULL.
 * - `region` (#128): normalizeRegionName() from @yavio/shared/geo — the rule
 *   the SDK applies too — and only next to a valid `country_code`: a region
 *   without its country says nothing; else NULL. Not mapped to ISO 3166-2.
 *   Checked last, so it sees the country as checked above.
 * - `session_source` (#144): one of SESSION_SOURCES from @yavio/shared/events,
 *   as sent; else NULL. The schema takes any short string so that this ingest
 *   keeps accepting the events of a newer SDK; a value it does not know yet is
 *   not stored, because the read side excludes sessions by this column.
 */
export function normalizeEvents(events: BaseEvent[], now = Date.now()): NormalizeResult {
  let clampedTimestamps = 0;
  let invalidFields = 0;

  const normalized = events.map((event) => {
    const out: Record<string, unknown> = { ...event };

    const time = Date.parse(event.timestamp);
    const clamped = Math.min(Math.max(time, now - MAX_PAST_MS), now + MAX_FUTURE_MS);
    if (clamped !== time) clampedTimestamps++;
    // Always written anew, in milliseconds: the schema takes any number of
    // fractional digits, ClickHouse's DateTime64(3) refuses 20 and more, and
    // Date.parse has already cut the value to milliseconds.
    out.timestamp = new Date(clamped).toISOString();

    const checks: Array<[string, (value: string) => string | null]> = [
      ["country_code", (v) => (COUNTRY_CODES.has(v.toUpperCase()) ? v.toUpperCase() : null)],
      [
        "conversion_currency",
        (v) => (CURRENCY_CODES.has(v.toUpperCase()) ? v.toUpperCase() : null),
      ],
      ["locale", canonicalLocale],
      ["region", (v) => (typeof out.country_code === "string" ? normalizeRegionName(v) : null)],
      ["session_source", (v) => (KNOWN_SESSION_SOURCES.has(v) ? v : null)],
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
