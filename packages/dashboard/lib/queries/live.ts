import { queryAnalytics } from "@/lib/clickhouse/analytics-client";
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
 * a backlog page by page. `ingested_at` is outside the sort and partition
 * keys, so every poll also keeps a `timestamp` bound to stay within the
 * current partitions.
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

/** Rows per poll, oldest first: a backlog larger than a page is walked over the next polls. */
const LIVE_PAGE = 50;

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
  return Date.parse(`${text.replace(" ", "T")}Z`);
}

/** The feed's start: ClickHouse's clock, one overlap window ago, so nothing is skipped on connect. */
export async function initialLiveCursor(ctx: QueryContext): Promise<LiveCursor> {
  const rows = await queryAnalytics<{ cursor: string }>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `SELECT toString(now64(3, 'UTC') - INTERVAL ${LIVE_OVERLAP_SECONDS} SECOND) AS cursor`,
  });
  const cursor = rows[0]?.cursor;
  if (!cursor) throw new Error("ClickHouse returned no clock");
  return { ingestedAt: cursor, seen: [] };
}

/** The bounds every poll reads within: the partition bound and the overlap window before the cursor. */
const WINDOW = `timestamp >= now() - INTERVAL 1 DAY
        AND ingested_at >= {cursor:DateTime64(3, 'UTC')} - INTERVAL ${LIVE_OVERLAP_SECONDS} SECOND`;

/**
 * One poll: the next page of rows ingested since the cursor (minus the
 * overlap), oldest first, without the ones the previous poll read, and
 * with one connection per session. Pure: the caller keeps the returned
 * cursor.
 */
export async function pollLive(
  ctx: QueryContext,
  cursor: LiveCursor,
  eventType?: string,
): Promise<LivePoll> {
  const typeFilter = eventType ? "AND event_type = {eventType:String}" : "";
  // Read in the previous poll and still inside the window: left out here,
  // not only after the fact, so the page holds rows not read yet.
  const seenFilter = cursor.seen.length > 0 ? "AND event_id NOT IN {seen:Array(String)}" : "";

  const rows = await queryAnalytics<LiveRow>({
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
        AND (
          event_type != 'connection'
          OR (session_id, ingested_at) IN (
            SELECT session_id, min(ingested_at)
            FROM events
            WHERE project_id = {projectId:String}
              AND event_type = 'connection'
              AND timestamp >= now() - INTERVAL 1 DAY
            GROUP BY session_id
          )
        )
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

  const seen = new Set(cursor.seen.map((row) => row.eventId));
  const connectionSessions = new Set<string>();
  const events: LiveEvent[] = [];
  for (const row of rows) {
    if (seen.has(row.eventId)) continue; // the query leaves them out; a guard against a stale page
    if (row.eventType === "connection") {
      if (connectionSessions.has(row.sessionId)) continue;
      connectionSessions.add(row.sessionId);
    }
    const { ingestedAt: _ingestedAt, ...event } = row;
    events.push(event);
  }

  let newest = cursor.ingestedAt;
  for (const row of rows) if (row.ingestedAt > newest) newest = row.ingestedAt;
  const windowStart = ingestedAtMs(newest) - LIVE_OVERLAP_MS;
  // Every row read so far — this poll's or earlier, shown or not — whose
  // ingested_at the next window covers again, so none is read twice. Rows
  // older than the window cannot come back: the cursor never moves
  // backwards.
  const read = new Map(cursor.seen.map((row) => [row.eventId, row]));
  for (const { eventId, ingestedAt } of rows) read.set(eventId, { eventId, ingestedAt });
  return {
    events,
    cursor: {
      ingestedAt: newest,
      seen: [...read.values()].filter((row) => ingestedAtMs(row.ingestedAt) >= windowStart),
    },
  };
}
