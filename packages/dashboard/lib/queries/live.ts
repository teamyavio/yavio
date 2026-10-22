import { queryAnalytics } from "@/lib/clickhouse/analytics-client";
import { parseUtc } from "@/lib/clickhouse/datetime";
import type { LiveEvent } from "./types";

/**
 * The live feed's read side (#148, Decision F).
 *
 * The feed tails `ingested_at` — when ingest received the event — not the
 * event's own `timestamp`. On a fleet, an instance whose 10 s batch lands
 * after a newer event from another instance would otherwise have its
 * events skipped for good. `ingested_at` is set before the batch writer's
 * 1 s flush and before any write retry (1/2/4 s), so a row becomes visible
 * a few seconds after its `ingested_at`: every poll re-reads the
 * `LIVE_OVERLAP` window before its cursor and leaves out the rows it
 * already read, by `event_id`, in the query itself. The page is read oldest
 * first: ingest stamps one `ingested_at` on a whole request batch (up to
 * 100 events), so a page of 50 newest-first would return the same 50 rows
 * of such a batch on every poll and the other 50 would never rank into a
 * page; oldest first with the read ids excluded, the cursor walks through
 * a backlog page by page — within one poll, up to `LIVE_MAX_PAGES` pages
 * (bounded catch-up, #148 review round 2): one page per 1.5 s poll fell
 * behind for good above ~33 events/s, with the cursor's `seen` list growing
 * with the backlog. A backlog larger than the cap is given up: the cursor
 * jumps to the newest `ingested_at` the feed would show among the rows of
 * the last `LIVE_SKEW_ALLOWANCE` (see `latestCursor`), so the live view
 * shows what was ingested in the last `LIVE_OVERLAP` window before that
 * and after, and the rows between the last page read and that window are
 * never shown.
 *
 * `ingested_at` is outside the sort key `(workspace_id, project_id,
 * event_type, timestamp, event_id)` and has no skip index, so a bound on
 * it alone prunes nothing: every poll sorted the project's whole last day
 * (#148 review round 4). Every poll therefore also bounds `timestamp` —
 * the sort key's fourth column — to the last `LIVE_SKEW_ALLOWANCE` before
 * the cursor: an event's `timestamp` is at most SDK batching + retries +
 * clock skew behind its `ingested_at`. The 1-day bound stays as the outer
 * limit (the current partitions).
 *
 * A `connection` row is shown only if its session has no connection row
 * with an earlier `ingested_at` in the preceding 24 h, and within one poll
 * only the earliest per session: a stateless fleet emits one connection
 * per instance that served a session (the SDK's once-only events are per
 * process), and the ids are random, so nothing collapses them on write.
 */

/** How far before the cursor a poll re-reads, in whole seconds (SQL `INTERVAL n SECOND`). */
export const LIVE_OVERLAP_SECONDS = 10;
const LIVE_OVERLAP_MS = LIVE_OVERLAP_SECONDS * 1_000;
/**
 * How far an event's `timestamp` may lie behind its `ingested_at`, in
 * whole seconds: the SDK's 10 s flush, its retries (1/2/4/8/16 s backoff,
 * a `Retry-After` of 30 s at most) and the clock skew between an app and
 * ingest add up to minutes at most; an hour is generous. Bounds
 * `timestamp` — in the sort key — so a poll does not sort the project's
 * whole day (#148 review round 4).
 */
export const LIVE_SKEW_ALLOWANCE_SECONDS = 3_600;
/** The `timestamp` bound before the cursor: the overlap, then the allowance behind it. */
const LIVE_LOOKBACK_SECONDS = LIVE_OVERLAP_SECONDS + LIVE_SKEW_ALLOWANCE_SECONDS;

/** Rows per page, oldest first. */
export const LIVE_PAGE = 50;
/**
 * Pages one poll reads at most (`LIVE_PAGE` × this rows). A backlog still
 * full after that is dropped: the cursor jumps to ClickHouse's clock.
 */
export const LIVE_MAX_PAGES = 10;

export interface QueryContext {
  workspaceId: string;
  projectId: string;
}

/**
 * Where the feed has read up to: the newest `ingested_at` read so far
 * (ClickHouse `DateTime64(3, 'UTC')` text, `YYYY-MM-DD HH:MM:SS.mmm`), and
 * the ids of the rows read whose `ingested_at` is still inside the overlap
 * window — the rows the next poll's window covers again, and leaves out.
 */
export interface LiveCursor {
  ingestedAt: string;
  seen: SeenRow[];
}

/** A row read, with its `ingested_at`: dropped from the cursor once the window has moved past it. */
export interface SeenRow {
  eventId: string;
  ingestedAt: string;
}

export interface LivePoll {
  /** Oldest first, deduplicated, one connection per session. */
  events: LiveEvent[];
  cursor: LiveCursor;
}

/** A row as the query returns it: the event plus where to resume from. */
interface LiveRow extends LiveEvent {
  ingestedAt: string;
}

/** `YYYY-MM-DD HH:MM:SS.mmm` (UTC) as epoch milliseconds. */
function ingestedAtMs(text: string): number {
  return parseUtc(text).getTime();
}

/**
 * Where the feed starts, and where a capped poll jumps to: the newest
 * `ingested_at` the feed would show (the type filter applies) among the
 * rows of the last `LIVE_SKEW_ALLOWANCE` — by `timestamp`, so the sort key
 * prunes — or ClickHouse's clock when there are none, as cursor text.
 * `ingested_at` is stamped by the ingest process's clock, not ClickHouse's:
 * a cursor taken from the clock hid every row for good once the two
 * differed by more than the overlap (#148 review round 4).
 */
async function latestCursor(ctx: QueryContext, eventType?: string): Promise<string> {
  const typeFilter = eventType ? "AND event_type = {eventType:String}" : "";
  const rows = await queryAnalytics<{ cursor: string }>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT toString(coalesce(maxOrNull(ingested_at), now64(3, 'UTC'))) AS cursor
      FROM events
      WHERE project_id = {projectId:String}
        AND timestamp >= now() - INTERVAL ${LIVE_SKEW_ALLOWANCE_SECONDS} SECOND
        ${typeFilter}
    `,
    params: { projectId: ctx.projectId, ...(eventType ? { eventType } : {}) },
  });
  const cursor = rows[0]?.cursor;
  if (!cursor) throw new Error("ClickHouse returned no cursor");
  return cursor;
}

/**
 * The feed's start: the newest `ingested_at` of the last hour (the clock
 * with no rows), without an overlap of its own — the poll's window before
 * the cursor is the overlap, so the first poll shows the last 10 s, not 20.
 */
export async function initialLiveCursor(
  ctx: QueryContext,
  eventType?: string,
): Promise<LiveCursor> {
  return { ingestedAt: await latestCursor(ctx, eventType), seen: [] };
}

/**
 * The bounds every poll reads within: the partition bound, the `timestamp`
 * bound the sort key prunes by, and the overlap window before the cursor.
 */
const WINDOW = `timestamp >= now() - INTERVAL 1 DAY
        AND timestamp >= {cursor:DateTime64(3, 'UTC')} - INTERVAL ${LIVE_LOOKBACK_SECONDS} SECOND
        AND ingested_at >= {cursor:DateTime64(3, 'UTC')} - INTERVAL ${LIVE_OVERLAP_SECONDS} SECOND`;

/**
 * A `connection` row passes only as its session's earliest in the last
 * day. The candidates are the sessions with a connection row in the polled
 * window — the only ones whose rows the poll can return, so the result is
 * the same as over every session of the day, without ranking a day of
 * connection rows on every poll. Left out when the type filter excludes
 * connections altogether.
 */
function connectionFilter(eventType: string | undefined): string {
  if (eventType !== undefined && eventType !== "connection") return "";
  return `AND (
          event_type != 'connection'
          OR (session_id, ingested_at) IN (
            SELECT session_id, min(ingested_at)
            FROM events
            WHERE project_id = {projectId:String}
              AND event_type = 'connection'
              AND timestamp >= now() - INTERVAL 1 DAY
              AND session_id IN (
                SELECT session_id
                FROM events
                WHERE project_id = {projectId:String}
                  AND event_type = 'connection'
                  AND ${WINDOW}
              )
            GROUP BY session_id
          )
        )`;
}

/** A row read, as `pollLive` keeps it: its `ingested_at` parsed once, so the window check does not re-parse it per page and per poll. */
interface ReadRow extends SeenRow {
  ms: number;
}

/** The ids read whose `ingested_at` the window before `ingestedAt` covers again. */
function withinWindow(read: Map<string, ReadRow>, ingestedAt: string): SeenRow[] {
  const windowStart = ingestedAtMs(ingestedAt) - LIVE_OVERLAP_MS;
  const rows: SeenRow[] = [];
  for (const { eventId, ingestedAt: at, ms } of read.values()) {
    if (ms >= windowStart) rows.push({ eventId, ingestedAt: at });
  }
  return rows;
}

/**
 * One poll: the rows ingested since the cursor (minus the overlap), oldest
 * first, page by page up to the cap, without the ones read before, and
 * with one connection per session. Pure: the caller keeps the returned
 * cursor.
 */
export async function pollLive(
  ctx: QueryContext,
  cursor: LiveCursor,
  eventType?: string,
): Promise<LivePoll> {
  const connectionSessions = new Set<string>();
  const events: LiveEvent[] = [];
  // Every row read so far — earlier polls' or this one's, shown or not —
  // with its ingested_at, so the next page and the next poll leave it out
  // while the window still covers it, and so a row read before is not
  // shown again. Rows older than the window cannot come back: the cursor
  // never moves backwards.
  const read = new Map<string, ReadRow>(
    cursor.seen.map((row) => [row.eventId, { ...row, ms: ingestedAtMs(row.ingestedAt) }]),
  );
  let newest = cursor.ingestedAt;
  let full = false;

  for (let page = 0; page < LIVE_MAX_PAGES; page++) {
    const rows = await readPage(
      ctx,
      { ingestedAt: newest, seen: withinWindow(read, newest) },
      eventType,
    );
    for (const row of rows) {
      if (row.ingestedAt > newest) newest = row.ingestedAt;
      // The query leaves out the rows read before; this also catches a
      // stale page and the same event_id twice in one page (a
      // ReplacingMergeTree holds at-least-once duplicates until it merges,
      // #148 review round 2).
      if (read.has(row.eventId)) continue;
      read.set(row.eventId, {
        eventId: row.eventId,
        ingestedAt: row.ingestedAt,
        ms: ingestedAtMs(row.ingestedAt),
      });
      if (row.eventType === "connection") {
        if (connectionSessions.has(row.sessionId)) continue;
        connectionSessions.add(row.sessionId);
      }
      const { ingestedAt: _ingestedAt, ...event } = row;
      events.push(event);
    }
    full = rows.length >= LIVE_PAGE;
    if (!full) break; // a short page: caught up
  }

  if (full) {
    // The cap: the backlog is larger than one poll walks. Give it up — the
    // live view shows the latest events, not a tail that only falls
    // further behind — by jumping to the newest `ingested_at` of the last
    // hour: the next window is the `LIVE_OVERLAP` seconds before it. Rows
    // between the last page read and that window are never shown; the
    // rows inside it that were not read come with the next poll (the read
    // ones stay excluded through `seen`). Never backwards: a jump behind
    // the last page read (the filter's newest row older than it) keeps the
    // cursor where the pages left it.
    const jump = await latestCursor(ctx, eventType);
    if (jump > newest) newest = jump;
  }

  return { events, cursor: { ingestedAt: newest, seen: withinWindow(read, newest) } };
}

/** One page of rows ingested since `cursor` (minus the overlap), oldest first, without the ids in `cursor.seen`. */
async function readPage(
  ctx: QueryContext,
  cursor: LiveCursor,
  eventType?: string,
): Promise<LiveRow[]> {
  const typeFilter = eventType ? "AND event_type = {eventType:String}" : "";
  // Read before and still inside the window: left out here, not only
  // after the fact, so the page holds rows not read yet.
  const seenFilter = cursor.seen.length > 0 ? "AND event_id NOT IN {seen:Array(String)}" : "";

  return queryAnalytics<LiveRow>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT
        event_id AS eventId,
        event_type AS eventType,
        event_name AS eventName,
        timestamp,
        session_id AS sessionId,
        trace_id AS traceId,
        user_id AS userId,
        platform,
        status,
        latency_ms AS latencyMs,
        error_category AS errorCategory,
        error_message AS errorMessage,
        toString(ingested_at) AS ingestedAt
      FROM events
      WHERE project_id = {projectId:String}
        AND ${WINDOW}
        ${connectionFilter(eventType)}
        ${typeFilter}
        ${seenFilter}
      ORDER BY ingested_at ASC, timestamp ASC, event_id ASC
      LIMIT ${LIVE_PAGE}
    `,
    params: {
      projectId: ctx.projectId,
      cursor: cursor.ingestedAt,
      ...(eventType ? { eventType } : {}),
      ...(cursor.seen.length > 0 ? { seen: cursor.seen.map((row) => row.eventId) } : {}),
    },
  });
}
