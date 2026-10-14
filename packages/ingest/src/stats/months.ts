/** Month arithmetic for the statistics job, in UTC. Months are "YYYY-MM-01". */

export function monthStart(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  return monthStart(new Date(Date.UTC(y, m - 1 + n, 1)));
}

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The partition id ClickHouse uses for PARTITION BY toYYYYMM(...): 202610. */
export function partitionId(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return y * 100 + m;
}

/**
 * The months a run must (re)compute, oldest first (#85, step 3):
 * - the previous and the current month, every day;
 * - every month since the last successful run, so an outage longer than a
 *   month cannot leave a month unfinished for good;
 * - on the first run (no state yet), every month that still has events — the
 *   backfill.
 * Finished months are never touched again, so their statistics stay frozen
 * after their raw data expires.
 */
export function monthsToProcess(
  lastSuccessAt: Date | null,
  now: Date,
  earliestEventMonth: string | null,
): string[] {
  const current = monthStart(now);
  const previous = addMonths(current, -1);
  let first = previous;
  if (lastSuccessAt === null) {
    if (earliestEventMonth !== null && earliestEventMonth < first) first = earliestEventMonth;
  } else {
    const lastMonth = monthStart(lastSuccessAt);
    if (lastMonth < first) first = lastMonth;
  }
  const months: string[] = [];
  for (let m = first; m <= current; m = addMonths(m, 1)) months.push(m);
  return months;
}

/** Whether a table's statistics already ran today (UTC). */
export function ranToday(lastSuccessAt: Date | null, now: Date): boolean {
  return lastSuccessAt !== null && utcDay(lastSuccessAt) === utcDay(now);
}
