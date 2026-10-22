/** A ClickHouse DateTime / DateTime64 as text: no zone marker, UTC. */
const CLICKHOUSE_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * A ClickHouse datetime ("2026-07-16 15:30:56.202") as a Date. It is a UTC
 * instant with no timezone marker, which `new Date()` would read as
 * SERVER-LOCAL time, so it is marked UTC first; an ISO string with a zone
 * and a Date pass through. Unparseable input gives an invalid Date, for
 * the caller to decide about. One parser for the range bounds, the event
 * timestamps and the live feed's cursor (#148 review round 4).
 */
export function parseUtc(value: string | Date): Date {
  if (value instanceof Date) return value;
  return new Date(CLICKHOUSE_DATETIME.test(value) ? `${value.replace(" ", "T")}Z` : value);
}
