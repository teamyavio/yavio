import type { Granularity } from "./validation";

/**
 * ClickHouse GROUP BY only returns buckets that contain events, so quiet
 * periods silently vanish from time series and distort the chart's time
 * axis. This fills the full bucket sequence for a range, inserting empty
 * points where the query returned nothing.
 */

function floorBucket(d: Date, granularity: Granularity): Date {
  const x = new Date(d.getTime());
  x.setUTCMinutes(0, 0, 0);
  if (granularity === "hour") return x;
  x.setUTCHours(0, 0, 0, 0);
  if (granularity === "day") return x;
  if (granularity === "week") {
    // ClickHouse toStartOfWeek default mode: weeks start on Sunday.
    x.setUTCDate(x.getUTCDate() - x.getUTCDay());
    return x;
  }
  x.setUTCDate(1);
  return x;
}

function nextBucket(d: Date, granularity: Granularity): Date {
  const x = new Date(d.getTime());
  if (granularity === "hour") x.setUTCHours(x.getUTCHours() + 1);
  else if (granularity === "day") x.setUTCDate(x.getUTCDate() + 1);
  else if (granularity === "week") x.setUTCDate(x.getUTCDate() + 7);
  else x.setUTCMonth(x.getUTCMonth() + 1);
  return x;
}

function bucketString(d: Date, granularity: Granularity): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  // toStartOfWeek/toStartOfMonth return a Date (no time part).
  if (granularity === "week" || granularity === "month") return date;
  return `${date} ${p(d.getUTCHours())}:00:00`;
}

/** Match buckets regardless of date-only vs. datetime serialisation. */
function canonical(bucket: string): string {
  return bucket.slice(0, 13);
}

const MAX_BUCKETS = 1000;

export function fillTimeBuckets<T extends { bucket: string }>(
  rows: T[],
  from: string | Date,
  to: string | Date,
  granularity: Granularity,
  empty: (bucket: string) => T,
): T[] {
  const start = floorBucket(new Date(from), granularity);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return rows;

  const byKey = new Map(rows.map((r) => [canonical(r.bucket), r]));
  const out: T[] = [];
  for (let d = start; d < end && out.length < MAX_BUCKETS; d = nextBucket(d, granularity)) {
    const bucket = bucketString(d, granularity);
    out.push(byKey.get(canonical(bucket)) ?? empty(bucket));
  }
  // Never drop real data: an oversized range falls back to the raw rows.
  return out.length >= MAX_BUCKETS ? rows : out;
}
