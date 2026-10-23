import { queryAnalytics } from "@/lib/clickhouse/analytics-client";
import { parseUtc } from "@/lib/clickhouse/datetime";
import type { LiveEvent } from "./types";

/**
 * The live feed's read side (#148, Decision F).
 *
 * The feed tails `ingested_at` — when ClickHouse stored the event: the
 * column's DEFAULT `now64(3)`, stamped at insert on ClickHouse's clock —
 * not the event's own `timestamp`. On a fleet, an instance whose 10 s batch
 * lands after a newer event from another instance would otherwise have its
 * events skipped for good. Until #148 review round 5 ingest stamped
 * `ingested_at` on receipt, before the batch writer's 1 s flush and its
 * retries (each waiting out the failed insert's own duration, tens of
 * seconds after a hanging first insert), so a row could become visible
 * after the overlap had moved past its `ingested_at` and was never shown;
 * stamped at insert, `ingested_at` is monotonic with visibility and the
 * overlap only has to cover the insert itself.
 *
 * The cursor is a position `(ingested_at, event_id)` (review round 6).
 * ClickHouse stamps ONE `ingested_at` on a whole insert block — the batch
 * writer's flush, up to 10 000 rows — so a cursor on `ingested_at` alone
 * sat still inside such a block and the pages could only walk it by
 * leaving out every id read so far (`event_id NOT IN …`, a list that grew
 * to the whole block and went with every page query). A page now reads
 * the rows after the last row read, `(ingested_at, event_id) > (…)`,
 * oldest first, up to `LIVE_MAX_PAGES` pages per poll; the cursor is the
 * newest position read, and nothing is listed to walk.
 *
 * Out-of-order visibility: two inserts stamped T1 < T2 can become visible
 * in the other order, so the rows at or before the cursor are not all
 * read. Every poll therefore re-reads the `LIVE_OVERLAP` window before the
 * cursor and leaves out, in the query, the blocks it has read: a block is
 * one `ingested_at` stamp, visible as a whole, and once a row of it was
 * read the walk read all of it — so the exclusion is by stamp, `ingested_at
 * NOT IN {stamps}`, a handful of values per window (one per insert) however
 * many rows they hold. The one case this misses: a late block stamped in
 * the same millisecond as a block already read is taken for read. A walk
 * the page cap ends inside the overlap (`LiveCursor.resume`) continues
 * there next poll, its partial block not excluded. The ids read are kept
 * in memory for `LIVE_RESEND_HORIZON` after they were read, and for as
 * long as the window covers their block, so a row read before is not
 * shown again: an SDK resend of a batch ingest had already stored is a new
 * block with a newer stamp, back inside the window (review round 5).
 *
 * A backlog larger than one poll walks is given up when it reaches more
 * than one window behind the newest row (bounded catch-up, review round
 * 2): the cursor jumps to the newest position (`latestCursor`), the rows
 * between the last row read and that row's window are never shown, and
 * the unread blocks inside the window come with the next poll. One page
 * per 1.5 s poll fell behind for good above ~33 events/s before round 2;
 * a backlog within one window is walked out instead of dropped (round 6).
 *
 * `ingested_at` is outside the sort key `(workspace_id, project_id,
 * event_type, timestamp, event_id)`; a minmax skip index on it (migration
 * 0021) lets the window bound prune the granules the `timestamp` bound
 * leaves. Before it, every poll sorted the project's whole last day (#148
 * review round 4), and the bound on `timestamp` that stood in for the
 * index — an hour before the cursor — hid every event of a host whose
 * clock runs more than an hour slow: ingest clamps a client timestamp to
 * [now − 72 h, now + 5 min], so such events are stored and were never
 * shown live (review round 6). The outer bound on `timestamp`
 * (`LIVE_TIMESTAMP_BOUND`, 73 h) stays for the sort key, not for the
 * partitions, which are monthly (review round 7).
 *
 * A `connection` row is shown only as its session's earliest in the
 * preceding 73 h — by `(ingested_at, event_id)`, so two rows of one block
 * (the same stamp) cannot both pass — and only once per session for as
 * long as the window covers the one shown (`LiveCursor.connections`): a
 * block visible late with an earlier row of the session would otherwise
 * pass as the new earliest and be shown as a second one. A stateless
 * fleet emits one connection per instance that served a session (the
 * SDK's once-only events are per process), and the ids are random, so
 * nothing collapses them on write.
 */

/** How far before the cursor a poll re-reads, in whole seconds (SQL `INTERVAL n SECOND`). */
export const LIVE_OVERLAP_SECONDS = 10;
const LIVE_OVERLAP_MS = LIVE_OVERLAP_SECONDS * 1_000;
/**
 * How long a row stays remembered after it was read (wall clock), in whole
 * seconds. An SDK resend of a batch ingest had already stored — the fetch
 * timed out or saw a 5xx after the write — lands as a NEW row with a new
 * `ingested_at` (the ReplacingMergeTree collapses it on a later merge),
 * inside the window again; remembered only for the window, its id was
 * emitted twice (#148 review round 5). The SDK's resends go on for up to
 * five more attempts, each a 30 s fetch timeout plus a backoff of 1, 2,
 * 4, 8 and 16 s (or a `Retry-After` of 30 s at most): about 180 s after
 * the first store, so 200 s. Measured from when the row was read, not
 * from the cursor: keyed on the cursor's stamp, 60 s of it had expired a
 * row resent 63 s later once the cursor had moved on, and the row was
 * shown twice (review round 6). Checked in memory; the query leaves out
 * blocks, not ids — and a row is kept while the window still covers its
 * block whatever the clock says, or its block would come back from the
 * query.
 */
export const LIVE_RESEND_HORIZON_SECONDS = 200;
const LIVE_RESEND_HORIZON_MS = LIVE_RESEND_HORIZON_SECONDS * 1_000;
/**
 * Rows remembered at most, per feed connection: the horizon's worth at the
 * page cap (500 rows per 1.5 s poll for 200 s is about 67 000) is more
 * than one viewer's feed will ever show; past the cap the rows read
 * longest ago are forgotten first, window or not.
 */
export const LIVE_SEEN_CAP = 50_000;
/** How far back a capped poll looks for the newest row to jump to, in whole seconds, by `ingested_at` (the skip index prunes). */
export const LIVE_JUMP_LOOKBACK_SECONDS = 3_600;

/** Rows per page, oldest first. */
export const LIVE_PAGE = 50;
/**
 * Pages one poll reads at most (`LIVE_PAGE` × this rows). A backlog still
 * full after that is walked on next poll, or given up when it reaches more
 * than one window behind the newest row.
 */
export const LIVE_MAX_PAGES = 10;
/**
 * Blocks (distinct `ingested_at` stamps) one page query leaves out at most.
 * An insert is a block, so a window holds a few dozen at most; past the
 * cap the oldest are left in and their rows come back to be dropped by the
 * in-memory check.
 */
export const LIVE_STAMPS_CAP = 1_000;

export interface QueryContext {
  workspaceId: string;
  projectId: string;
}

/** A position in the feed's order: `ingested_at` (ClickHouse `DateTime64(3, 'UTC')` text, `YYYY-MM-DD HH:MM:SS.mmm`) and `event_id`. */
export interface LivePosition {
  ingestedAt: string;
  eventId: string;
}

/**
 * Where the feed has read up to: the newest position read so far, a walk
 * the page cap ended below it (resumed there next poll), and the rows
 * read within the resend horizon or inside the window — the rows a resend
 * could bring back, and the blocks the next poll leaves out while the
 * window covers them.
 */
export interface LiveCursor extends LivePosition {
  resume?: LivePosition;
  seen: SeenRow[];
  /** The sessions whose connection row was shown, with its block, while the window still covers that block. */
  connections: SeenConnection[];
}

export interface SeenConnection {
  sessionId: string;
  ingestedAt: string;
}

/** A row read: its `ingested_at` (its block) and when it was read (epoch ms); dropped once the horizon has passed the latter and the window the former. */
export interface SeenRow {
  eventId: string;
  ingestedAt: string;
  readAt: number;
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

/** Is `a` after `b` in the feed's order? The stamps share one format, so text order is time order. */
function after(a: LivePosition, b: LivePosition): boolean {
  return a.ingestedAt > b.ingestedAt || (a.ingestedAt === b.ingestedAt && a.eventId > b.eventId);
}

/**
 * Where a capped poll jumps to: the newest position the feed would show
 * (the type filter applies) among the rows stored in the last
 * `LIVE_JUMP_LOOKBACK` — by `ingested_at`, the skip index pruning, within
 * `LIVE_TIMESTAMP_BOUND` — or ClickHouse's clock when there are none. The newest row
 * rather than the clock: the backlog the jump gives up may end before the
 * clock's window, and the blocks of its last `LIVE_OVERLAP` seconds are
 * what the next poll shows (#148 review rounds 2 and 4).
 */
async function latestCursor(ctx: QueryContext, eventType?: string): Promise<LivePosition> {
  const typeFilter = eventType ? "AND event_type = {eventType:String}" : "";
  const rows = await queryAnalytics<{ ingestedAt: string; eventId: string | null }>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT
        toString(coalesce(maxOrNull(ingested_at), now64(3, 'UTC'))) AS ingestedAt,
        argMaxOrNull(event_id, (ingested_at, event_id)) AS eventId
      FROM events
      WHERE project_id = {projectId:String}
        AND ${LIVE_TIMESTAMP_BOUND}
        AND ingested_at >= now64(3, 'UTC') - INTERVAL ${LIVE_JUMP_LOOKBACK_SECONDS} SECOND
        ${typeFilter}
    `,
    params: { projectId: ctx.projectId, ...(eventType ? { eventType } : {}) },
  });
  const row = rows[0];
  if (!row?.ingestedAt) throw new Error("ClickHouse returned no cursor");
  return { ingestedAt: row.ingestedAt, eventId: row.eventId ?? "" };
}

/**
 * The feed's start: ClickHouse's clock, as a position, without an overlap
 * of its own — the poll's window before the cursor is the overlap, so the
 * first poll shows what was stored in the last 10 s, not 20 (#148 review
 * rounds 2 and 4). The clock, not the newest `ingested_at` of the last
 * hour, which replayed up to an hour-old events as live on every
 * (re)connect once round 4 had made it the start: that was a guard against
 * the skew between ingest's clock and ClickHouse's, gone since ClickHouse
 * stamps `ingested_at` at insert (review round 5). Keyed by project like
 * every query, for the row policy; no table is read.
 */
export async function initialLiveCursor(ctx: QueryContext): Promise<LiveCursor> {
  const rows = await queryAnalytics<{ cursor: string }>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: "SELECT toString(now64(3, 'UTC')) AS cursor",
  });
  const cursor = rows[0]?.cursor;
  if (!cursor) throw new Error("ClickHouse returned no cursor");
  return { ingestedAt: cursor, eventId: "", seen: [], connections: [] };
}

/**
 * The outer bound on `timestamp`, for the sort key: ingest stores a client
 * timestamp down to now − 72 h (`MAX_PAST_MS` in its event normalizer), so
 * a tighter bound hides every event of a host whose clock runs that slow —
 * the 1-day bound before review round 7 those of a host 24–72 h slow — and
 * one hour on top covers the time between that clamp and the poll. Every
 * query here uses this one bound: the connection subquery with a tighter
 * one would fail such a host's connection rows on its `IN` filter.
 */
const LIVE_TIMESTAMP_BOUND = "timestamp >= now() - INTERVAL 73 HOUR";

/**
 * The bounds every poll reads within: the outer bound on `timestamp`, and
 * the overlap window before the cursor on `ingested_at`, which the skip
 * index prunes by.
 */
const WINDOW = `${LIVE_TIMESTAMP_BOUND}
        AND ingested_at >= {cursor:DateTime64(3, 'UTC')} - INTERVAL ${LIVE_OVERLAP_SECONDS} SECOND`;

/**
 * A `connection` row passes only as its session's earliest within
 * `LIVE_TIMESTAMP_BOUND`, by `(ingested_at, event_id)`: with
 * `min(ingested_at)` alone, two connection rows of one session stored in
 * one insert block — the same stamp — both passed, and a page cap or a
 * jump between them showed two connections for the session (#148 review
 * round 6). The candidates are the sessions with a connection row in the
 * polled window — the only ones whose rows the poll can return, so the
 * result is the same as over every session within the bound, without
 * ranking all of their connection rows on every poll. Left out when the
 * type filter excludes connections altogether.
 */
function connectionFilter(eventType: string | undefined): string {
  if (eventType !== undefined && eventType !== "connection") return "";
  return `AND (
          event_type != 'connection'
          OR (session_id, ingested_at, event_id) IN (
            SELECT session_id, min(ingested_at), argMin(event_id, (ingested_at, event_id))
            FROM events
            WHERE project_id = {projectId:String}
              AND event_type = 'connection'
              AND ${LIVE_TIMESTAMP_BOUND}
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

/**
 * The rows the cursor keeps: read within the horizon, or in a block the
 * window before `cursor` still covers; at most `LIVE_SEEN_CAP`, the rows
 * read longest ago dropped first.
 */
function retained(read: Map<string, ReadRow>, cursor: LivePosition, now: number): SeenRow[] {
  const windowStart = ingestedAtMs(cursor.ingestedAt) - LIVE_OVERLAP_MS;
  const horizonStart = now - LIVE_RESEND_HORIZON_MS;
  let rows: SeenRow[] = [];
  for (const { eventId, ingestedAt, readAt, ms } of read.values()) {
    if (readAt >= horizonStart || ms >= windowStart) rows.push({ eventId, ingestedAt, readAt });
  }
  if (rows.length > LIVE_SEEN_CAP) {
    rows = rows.sort((a, b) => b.readAt - a.readAt).slice(0, LIVE_SEEN_CAP);
  }
  return rows;
}

/**
 * The blocks the overlap window still covers and the walk has read: their
 * stamps, newest first, at most `LIVE_STAMPS_CAP` — less the block a
 * capped walk stopped inside (`resume`), which is read only up to that
 * row. Fixed for the whole poll: the pages walk by position, and a block
 * read by one page must stay in the next page's result.
 */
function readStamps(
  read: Map<string, ReadRow>,
  cursor: LivePosition,
  resume: LivePosition | undefined,
): string[] {
  const start = ingestedAtMs(cursor.ingestedAt) - LIVE_OVERLAP_MS;
  const stamps = new Set<string>();
  for (const { ingestedAt, ms } of read.values()) {
    if (ms >= start && ingestedAt !== resume?.ingestedAt) stamps.add(ingestedAt);
  }
  return [...stamps].sort().reverse().slice(0, LIVE_STAMPS_CAP);
}

/**
 * One poll: the rows after the cursor and the unread blocks of the window
 * before it, oldest first, page by page up to the cap, without the rows
 * read before, and with one connection per session. Pure: the caller
 * keeps the returned cursor.
 */
export async function pollLive(
  ctx: QueryContext,
  cursor: LiveCursor,
  eventType?: string,
): Promise<LivePoll> {
  // `?eventType=` arrives as "": no filter, as with no parameter. Every
  // query below takes the type from here; before #148 review round 10 the
  // type filters read "" as none and `connectionFilter` as a type other
  // than `connection`, leaving the one-connection-per-session subquery out.
  const type = eventType || undefined;
  // The sessions whose connection row was shown — by earlier polls, while
  // the window still covers it, and by this one — with that row's block.
  const connections = new Map<string, { ingestedAt: string; ms: number }>(
    cursor.connections.map((c) => [c.sessionId, { ...c, ms: ingestedAtMs(c.ingestedAt) }]),
  );
  const events: LiveEvent[] = [];
  // Every row read so far — earlier polls' or this one's, shown or not —
  // with its ingested_at: a row read before is not shown again, however it
  // comes back (a resend's new block, a stale page, the same event_id twice
  // in one page — a ReplacingMergeTree holds at-least-once duplicates until
  // it merges, review round 2), for as long as the resend horizon keeps
  // the id or the window its block.
  const now = Date.now();
  const read = new Map<string, ReadRow>(
    cursor.seen.map((row) => [row.eventId, { ...row, ms: ingestedAtMs(row.ingestedAt) }]),
  );
  const start: LivePosition = { ingestedAt: cursor.ingestedAt, eventId: cursor.eventId };
  const stamps = readStamps(read, start, cursor.resume);
  // The walk's lower bound: where a capped walk stopped last poll, else the
  // window's start; then the last row of each page.
  let lower = cursor.resume;
  let last: LivePosition | undefined;
  let full = false;

  for (let page = 0; page < LIVE_MAX_PAGES; page++) {
    const rows = await readPage(ctx, { start, lower, stamps }, type);
    for (const row of rows) {
      last = { ingestedAt: row.ingestedAt, eventId: row.eventId };
      const before = read.get(row.eventId);
      if (before) {
        // Read before (a resend's row, or a stale page): not shown again.
        // Remembered from now and from its newest block, so it stays in
        // the cursor for as long as the horizon or the window covers that.
        before.readAt = now;
        if (row.ingestedAt > before.ingestedAt) {
          before.ingestedAt = row.ingestedAt;
          before.ms = ingestedAtMs(row.ingestedAt);
        }
        continue;
      }
      read.set(row.eventId, {
        eventId: row.eventId,
        ingestedAt: row.ingestedAt,
        readAt: now,
        ms: ingestedAtMs(row.ingestedAt),
      });
      if (row.eventType === "connection") {
        if (connections.has(row.sessionId)) continue;
        connections.set(row.sessionId, {
          ingestedAt: row.ingestedAt,
          ms: ingestedAtMs(row.ingestedAt),
        });
      }
      const { ingestedAt: _ingestedAt, ...event } = row;
      events.push(event);
    }
    if (last) lower = last;
    full = rows.length >= LIVE_PAGE;
    if (!full) break; // a short page: caught up
  }

  // The next cursor: the newest position read, never backwards. A capped
  // walk that is still inside the overlap resumes there next poll.
  let next = start;
  let resume: LivePosition | undefined;
  if (last && after(last, start)) next = last;
  else if (full && last) resume = last;

  if (full) {
    // The cap, and the backlog reaches more than one window behind the
    // newest row the feed would show: give it up — the live view shows
    // the latest events, not a tail that only falls further behind — by
    // jumping to that row. The rows between the last row read and its
    // window are never shown; the unread blocks inside the window come
    // with the next poll. Within one window the walk goes on next poll
    // instead: a burst stored at one stamp is walked out, not cut.
    const newest = await latestCursor(ctx, type);
    if (ingestedAtMs(newest.ingestedAt) > ingestedAtMs(next.ingestedAt) + LIVE_OVERLAP_MS) {
      next = newest;
      resume = undefined;
    }
  }

  const windowStart = ingestedAtMs(next.ingestedAt) - LIVE_OVERLAP_MS;
  return {
    events,
    cursor: {
      ...next,
      ...(resume ? { resume } : {}),
      seen: retained(read, next, now),
      connections: [...connections]
        .filter(([, c]) => c.ms >= windowStart)
        .map(([sessionId, c]) => ({ sessionId, ingestedAt: c.ingestedAt })),
    },
  };
}

/** What one page reads within: the poll's cursor (the window before it, and what is after it), the walk's lower bound, the blocks read. */
interface PageBounds {
  start: LivePosition;
  lower: LivePosition | undefined;
  stamps: string[];
}

/**
 * One page: the rows after `lower` — or from the window's start — that are
 * after the cursor or in a block of the window not read yet, oldest first.
 */
async function readPage(
  ctx: QueryContext,
  { start, lower, stamps }: PageBounds,
  eventType?: string,
): Promise<LiveRow[]> {
  const typeFilter = eventType ? "AND event_type = {eventType:String}" : "";
  const lowerFilter = lower
    ? "AND (ingested_at, event_id) > ({lower:DateTime64(3, 'UTC')}, {lowerId:String})"
    : "";
  // Before the cursor only the blocks not read yet; after it everything.
  const unreadFilter =
    stamps.length > 0
      ? `AND (
          (ingested_at, event_id) > ({cursor:DateTime64(3, 'UTC')}, {cursorId:String})
          OR ingested_at NOT IN {stamps:Array(DateTime64(3, 'UTC'))}
        )`
      : "";

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
        ${lowerFilter}
        ${unreadFilter}
        ${connectionFilter(eventType)}
        ${typeFilter}
      ORDER BY ingested_at ASC, event_id ASC
      LIMIT ${LIVE_PAGE}
    `,
    params: {
      projectId: ctx.projectId,
      cursor: start.ingestedAt,
      cursorId: start.eventId,
      ...(lower ? { lower: lower.ingestedAt, lowerId: lower.eventId } : {}),
      ...(stamps.length > 0 ? { stamps } : {}),
      ...(eventType ? { eventType } : {}),
    },
  });
}
