/**
 * SQL for the anonymous-statistics job (#85, step 3). Each builder returns the
 * INSERT that fills a stage table for one month; the job then swaps that month
 * into the stats table with REPLACE PARTITION.
 *
 * Every query starts from the same prelude:
 * - `session_map`: per project, each session_id mapped to the first user_id
 *   an identify row gave it (#145) — identify() stamps user_id only on the
 *   events of the SDK process that called it, from that call on, so another
 *   instance's events in the conversation, and the earlier ones, carry none.
 *   Same rule as the dashboard's keyedEvents(); same window and retention
 *   floor as `base`. Never a `per_request` session (#144): since SDK 0.5.5
 *   it is one call, and on 0.5.4 a long-lived MCP SDK v1 1.24/1.25 server
 *   that reused one stateless transport put every key-less caller into one
 *   such session (#169), so one caller's identify would key everybody's
 *   events;
 * - `stitch`: per project, each subject_id mapped to the user_id last seen
 *   together with it (#89), so a person counted before identify() and after it
 *   is one person — read from the same window as `base` (#112): the mapping
 *   only has to cover the subject_ids that appear there, and reading it from
 *   all events repeated a project-wide scan per table and month;
 * - `base`: the window's events from `events FINAL`, existing projects only,
 *   deduplicated with LIMIT 1 BY event_id (FINAL alone misses a clamped event
 *   the SDK re-sent: different timestamp, so a different sort key, #90);
 * - `keyed`: base plus the user key
 *   coalesce(user_id, the session's first user_id, stitched user_id,
 *   subject_id) — never the session itself.
 *
 * Both maps name their project column (`session_project`, `stitch_project`):
 * with two LEFT JOINs whose maps both expose `project_id`, ClickHouse 26.8
 * names the outer column `b.project_id` in `SELECT b.*`, and every later
 * reference to `project_id` fails with UNKNOWN_IDENTIFIER (#145).
 *
 * Parameters are bound by ClickHouse ({name:Type}); nothing is interpolated
 * except the stage table names, which are constants.
 *
 * Never alias an expression to the name of a column a WHERE also refers to:
 * ClickHouse resolves the alias first, so `assumeNotNull(user_key) AS user_key
 * ... WHERE user_key IS NOT NULL` turned a missing key into '' and counted it
 * as a person.
 */

import { addMonths } from "./months.js";

/** Months are passed as their first day (YYYY-MM-01). */
export interface MonthWindow {
  /** First day of the month. */
  monthStart: string;
  /** First day of the next month. */
  nextMonthStart: string;
  /** Today (UTC): days and periods on or after it are not written yet. */
  today: string;
  /**
   * The day the stored events start (EARLIEST_MONTH). A period or cohort that
   * begins before it cannot be counted from what is kept.
   */
  dataStart: string;
  /** Projects keeping less than the platform window, and their floors (#93). */
  floorProjects: string[];
  floorDates: string[];
}

/** Below this many distinct individuals a free-text event_name is not admitted (see stats_daily). */
export const VOCAB_MIN_INDIVIDUALS = 5;
/** At most this many non-registered event names per project and month. */
export const VOCAB_TOP_N = 50;
/** client_name is trimmed and cut to this length. */
export const CLIENT_NAME_MAX = 64;

/**
 * The project's retention floor for the month being computed (#93), or
 * 1970-01-01 for a project at the platform window (indexOf finds nothing and
 * element 0 of a constant array is the default value).
 */
const FLOOR = (projectId: string) =>
  `{floorDates:Array(Date)}[indexOf({floorProjects:Array(String)}, ${projectId})]`;
/** Same expression as the TTL and the retention delete. */
const COLLECTED = "toDate(least(toDateTime(timestamp), toDateTime(ingested_at)))";

function prelude(from: string, to: string): string {
  return `
  session_map AS (
    SELECT project_id AS session_project, session_id AS stitched_session,
           argMin(assumeNotNull(user_id), (timestamp, event_id)) AS session_user_id
    FROM events
    WHERE project_id IN {projects:Array(String)}
      AND event_type = 'identify'
      AND user_id IS NOT NULL AND user_id != ''
      AND session_id != ''
      AND ifNull(session_source, '') != 'per_request'
      AND timestamp >= ${from} AND timestamp < ${to}
      AND ${COLLECTED} >= ${FLOOR("project_id")}
    GROUP BY session_project, stitched_session
  ),
  stitch AS (
    SELECT project_id AS stitch_project, assumeNotNull(subject_id) AS stitched_subject,
           argMax(assumeNotNull(user_id), timestamp) AS mapped_user_id
    FROM events
    WHERE project_id IN {projects:Array(String)}
      AND subject_id IS NOT NULL AND subject_id != ''
      AND user_id IS NOT NULL AND user_id != ''
      AND timestamp >= ${from} AND timestamp < ${to}
      AND ${COLLECTED} >= ${FLOOR("project_id")}
    GROUP BY stitch_project, stitched_subject
  ),
  base AS (
    SELECT * FROM events FINAL
    WHERE project_id IN {projects:Array(String)}
      AND timestamp >= ${from} AND timestamp < ${to}
      AND ${COLLECTED} >= ${FLOOR("project_id")}
    LIMIT 1 BY event_id
  ),
  keyed AS (
    SELECT b.*,
           coalesce(nullIf(b.user_id, ''), nullIf(m.session_user_id, ''),
                    nullIf(s.mapped_user_id, ''), nullIf(b.subject_id, '')) AS user_key
    FROM base AS b
    LEFT JOIN session_map AS m ON m.session_project = b.project_id AND m.stitched_session = b.session_id
    LEFT JOIN stitch AS s ON s.stitch_project = b.project_id AND s.stitched_subject = ifNull(b.subject_id, '')
  )`;
}

const MONTH = "toDateTime64({monthStart:Date}, 3, 'UTC')";
const NEXT_MONTH = "toDateTime64({nextMonthStart:Date}, 3, 'UTC')";

/**
 * `events`: rows, except that `connection` rows count distinct sessions.
 * The SDK emits a connection event at least once per session per process
 * (every instance of a stateless fleet that serves the conversation, every
 * LRU restart), with a random event_id and its own timestamp, so the rows
 * never collapse under FINAL or LIMIT 1 BY event_id; what the event means
 * is "this session connected", and every dashboard number already counts
 * sessions as uniqExact(session_id) (#142). Every cell groups by event_type
 * (or holds conversions only), so the two terms never mix inside a cell.
 * A `per_request` session (#144) is a key-less HTTP call, not a
 * conversation, and its connection row is emitted once per process per
 * client rather than once per session: such rows never reach a cell (see
 * `cells` in statsDailyInsert), so a connection cell counts sessions only.
 */
const MEASURES = `
    countIf(event_type != 'connection') + uniqExactIf(session_id, event_type = 'connection') AS events,
    uniqExact(individual) AS individuals,
    sum(ifNull(latency_ms, 0)) AS latency_sum,
    countIf(latency_ms IS NOT NULL) AS latency_count,
    countIf(event_type = 'conversion') AS conversions,
    sumIf(ifNull(conversion_value, 0), event_type = 'conversion') AS conversion_value`;

/**
 * stats_daily: the five slices for one month.
 *
 * Vocabulary (free text must not reach a table kept indefinitely):
 * - event_name: kept if it is a registered tool of the project, or one of the
 *   project's top VOCAB_TOP_N names of the month with at least
 *   VOCAB_MIN_INDIVIDUALS distinct individuals; otherwise '(other)'. This
 *   admission threshold is separate from the minimum cell size, which folds
 *   whole cells and ships later (#85).
 * - platform: the SDK's platform enum, anything else 'other';
 * - client_name: trimmed, at most CLIENT_NAME_MAX characters;
 * - country_code / conversion_currency: only well-formed codes (#90 checks
 *   them at ingest; this also covers rows stored before that);
 * - language: the primary subtag of locale.
 * client_version and is_retry are not carried over.
 *
 * Who an individual is: the user key, else the session — except a
 * `per_request` session (#144). A client that sends no session key over
 * HTTP has a new session per call (on any host since SDK 0.5.5, on a
 * per-request host before), so five calls from one person
 * would be five individuals: enough to admit a free-text event_name into a
 * table kept forever. Such an event without a user key is nobody, and the
 * per-request connection rows (one per process per client, not per session)
 * are left out of the cells altogether. Widget rows follow the same rule:
 * a 0.5.4 widget stamps its server session's source (#144 review round 1).
 * A NULL session_source (an SDK before 0.5.4, server or widget) counts as
 * before.
 */
export function statsDailyInsert(stage: string): string {
  return `
INSERT INTO ${stage}
WITH ${prelude(MONTH, NEXT_MONTH)},
  cells AS (
    SELECT
      workspace_id, project_id, toDate(timestamp) AS day, event_type,
      ifNull(event_name, '') AS raw_name,
      ifNull(status, '') AS status_v,
      ifNull(error_category, '') AS error_v,
      multiIf(ifNull(platform, '') = '', '',
              platform IN {platforms:Array(String)}, assumeNotNull(platform),
              'other') AS platform_v,
      substring(trimBoth(ifNull(client_name, '')), 1, ${CLIENT_NAME_MAX}) AS client_v,
      if(match(ifNull(country_code, ''), '^[A-Z]{2}$'), assumeNotNull(country_code), '') AS country_v,
      if(match(lower(splitByChar('-', ifNull(locale, ''))[1]), '^[a-z]{2,3}$'),
         lower(splitByChar('-', ifNull(locale, ''))[1]), '') AS language_v,
      if(match(ifNull(conversion_currency, ''), '^[A-Z]{3}$'), assumeNotNull(conversion_currency), '') AS currency_v,
      coalesce(user_key,
               if(ifNull(session_source, '') = 'per_request', NULL, nullIf(session_id, ''))) AS individual,
      session_id, latency_ms, conversion_value
    FROM keyed
    WHERE NOT (event_type = 'connection' AND ifNull(session_source, '') = 'per_request')
  ),
  registered AS (
    SELECT DISTINCT project_id, tool_name FROM tool_registry
    WHERE project_id IN {projects:Array(String)}
  ),
  admitted AS (
    SELECT project_id, raw_name FROM cells
    WHERE raw_name != ''
    GROUP BY project_id, raw_name
    HAVING uniqExact(individual) >= {vocabMinIndividuals:UInt32}
    ORDER BY project_id, count() DESC, raw_name
    LIMIT {vocabTopN:UInt32} BY project_id
  ),
  named AS (
    SELECT *,
      multiIf(raw_name = '', '',
              (project_id, raw_name) IN (SELECT project_id, tool_name FROM registered), raw_name,
              (project_id, raw_name) IN (SELECT project_id, raw_name FROM admitted), raw_name,
              '(other)') AS name_v
    FROM cells
  )
SELECT workspace_id, project_id, 'total' AS slice, day, event_type,
       '' AS event_name, '' AS status, '' AS error_category, '' AS platform, '' AS client_name,
       '' AS country_code, '' AS language, '' AS conversion_currency, ${MEASURES}
FROM named GROUP BY workspace_id, project_id, day, event_type
UNION ALL
SELECT workspace_id, project_id, 'tool', day, event_type,
       name_v, status_v, error_v, '', '', '', '', '', ${MEASURES}
FROM named GROUP BY workspace_id, project_id, day, event_type, name_v, status_v, error_v
UNION ALL
SELECT workspace_id, project_id, 'client', day, event_type,
       '', '', '', platform_v, client_v, '', '', '', ${MEASURES}
FROM named GROUP BY workspace_id, project_id, day, event_type, platform_v, client_v
UNION ALL
SELECT workspace_id, project_id, 'geo', day, event_type,
       '', '', '', '', '', country_v, language_v, '', ${MEASURES}
FROM named GROUP BY workspace_id, project_id, day, event_type, country_v, language_v
UNION ALL
SELECT workspace_id, project_id, 'conversion', day, '',
       name_v, '', '', '', '', '', '', currency_v, ${MEASURES}
FROM named WHERE event_type = 'conversion'
GROUP BY workspace_id, project_id, day, name_v, currency_v`;
}

/**
 * stats_users_daily: DAU, and WAU/MAU over the 7 and 30 days ending each day
 * of the month, up to yesterday. Reads 29 days before the month for the
 * rolling windows. The user key only, no session fallback.
 */
export function statsUsersDailyInsert(stage: string): string {
  return `
INSERT INTO ${stage}
WITH ${prelude(`${MONTH} - INTERVAL 29 DAY`, NEXT_MONTH)},
  active AS (
    SELECT DISTINCT workspace_id, project_id, assumeNotNull(user_key) AS person,
           toDate(timestamp) AS active_day
    FROM keyed WHERE user_key IS NOT NULL
  )
SELECT workspace_id, project_id, addDays(active_day, days_back) AS day,
       uniqExactIf(person, days_back = 0) AS dau,
       uniqExactIf(person, days_back < 7) AS wau,
       uniqExact(person) AS mau
FROM active ARRAY JOIN range(30) AS days_back
WHERE day >= {monthStart:Date} AND day < {nextMonthStart:Date} AND day < {today:Date}
GROUP BY workspace_id, project_id, day`;
}

/**
 * stats_users_periods: distinct users per calendar week (from Monday),
 * month, quarter and year, for the periods that END in this month and have
 * closed. Reads 12 months before the month, which covers a whole year.
 * A period that begins before the stored data starts, or before the
 * project's retention floor, is left out: its distinct users cannot be
 * counted from what is kept, and a month's figures are never recomputed once
 * its raw data is gone. Without the former, the first run after the TTL grew
 * from 90 days to 13 months (0013) froze a year and a quarter counted from a
 * few months of events.
 */
export function statsUsersPeriodsInsert(stage: string): string {
  return `
INSERT INTO ${stage}
WITH ${prelude(`${MONTH} - INTERVAL 12 MONTH`, NEXT_MONTH)},
  active AS (
    SELECT DISTINCT workspace_id, project_id, assumeNotNull(user_key) AS person,
           toDate(timestamp) AS d
    FROM keyed WHERE user_key IS NOT NULL
  ),
  periods AS (
    SELECT workspace_id, project_id, person,
           p.1 AS period, p.2 AS period_start, p.3 AS period_end
    FROM active
    ARRAY JOIN [
      ('week',    toMonday(d),         addDays(toMonday(d), 6)),
      ('month',   toStartOfMonth(d),   toLastDayOfMonth(d)),
      ('quarter', toStartOfQuarter(d), addDays(addQuarters(toStartOfQuarter(d), 1), -1)),
      ('year',    toStartOfYear(d),    addDays(addYears(toStartOfYear(d), 1), -1))
    ] AS p
  )
SELECT workspace_id, project_id, period, period_start, period_end, uniqExact(person) AS users
FROM periods
WHERE period_end >= {monthStart:Date} AND period_end < {nextMonthStart:Date}
  AND period_end < {today:Date}
  AND period_start >= {dataStart:Date}
  AND period_start >= ${FLOOR("project_id")}
GROUP BY workspace_id, project_id, period, period_start, period_end`;
}

/**
 * stats_cohorts: users active in this month, by the month they were first
 * seen (offset 0-12). "First seen" is the earliest event still stored, so
 * only cohorts after the month the stored data starts in — and, below the
 * platform window, after the project's floor month: someone first seen IN
 * that month may have been seen before it.
 */
export function statsCohortsInsert(stage: string): string {
  return `
INSERT INTO ${stage}
WITH ${prelude("toDateTime64(0, 3, 'UTC')", NEXT_MONTH)},
  first_seen AS (
    SELECT project_id, assumeNotNull(user_key) AS person,
           toStartOfMonth(min(timestamp)) AS cohort_month
    FROM keyed WHERE user_key IS NOT NULL
    GROUP BY project_id, person
  ),
  active AS (
    SELECT DISTINCT workspace_id, project_id, assumeNotNull(user_key) AS person
    FROM keyed
    WHERE user_key IS NOT NULL AND timestamp >= ${MONTH}
  )
SELECT a.workspace_id AS workspace_id, a.project_id AS project_id, f.cohort_month AS cohort_month,
       {monthStart:Date} AS activity_month,
       toUInt8(dateDiff('month', f.cohort_month, {monthStart:Date})) AS month_offset,
       uniqExact(a.person) AS users
FROM active AS a
INNER JOIN first_seen AS f ON f.project_id = a.project_id AND f.person = a.person
WHERE dateDiff('month', f.cohort_month, {monthStart:Date}) BETWEEN 0 AND 12
  AND f.cohort_month > toStartOfMonth({dataStart:Date})
  AND f.cohort_month > ${FLOOR("a.project_id")}
GROUP BY workspace_id, project_id, cohort_month, month_offset`;
}

/**
 * The first month that still has events for these projects, and the day the
 * stored data starts: the earliest collected date — the earlier of timestamp
 * and ingested_at, the TTL's clock (0013). n = 0 means there is none.
 */
export const EARLIEST_MONTH = `
SELECT toString(toStartOfMonth(min(timestamp))) AS month,
       toString(toDate(min(least(toDateTime(timestamp), toDateTime(ingested_at))))) AS data_start,
       count() AS n
FROM events
WHERE project_id IN {projects:Array(String)}`;

/** The platform window; projects at this value need no extra delete. */
export const PLATFORM_RETENTION_MONTHS = 13;

/**
 * Retention floors for one month (#93): for each project keeping R < 13
 * months, the first day of month M + 2 - R. The statistics of month M read
 * only events collected on or after it.
 *
 * Why that day: month M is recomputed at the latest on the last day of M + 1
 * (as the previous month; a catch-up only reaches months since the last
 * success, and a delete only follows a successful run). Every delete before
 * then cut at most start(M + 2) - R months — so everything from the floor on
 * is still there at every recompute of M, and every recompute reads exactly
 * the same rows. Without it, the measures that look back (WAU/MAU, quarter
 * and year users, cohort first-seen) drifted day by day as the delete took
 * their older events.
 */
export function retentionFloors(
  projects: ReadonlyArray<{ id: string; retentionMonths: number }>,
  month: string,
): { floorProjects: string[]; floorDates: string[] } {
  const short = projects.filter((p) => p.retentionMonths < PLATFORM_RETENTION_MONTHS);
  return {
    floorProjects: short.map((p) => p.id),
    floorDates: short.map((p) => addMonths(month, 2 - p.retentionMonths)),
  };
}

/**
 * Per-project retention (#93): ONE statement for every project that keeps
 * less than the platform window — each ALTER TABLE ... DELETE is a separate
 * mutation, so one per project would pile them up. Projects are grouped by
 * their retention; each group is one OR branch with its own parameters.
 * Counted like the TTL (0013): from the earlier of timestamp and ingested_at.
 * Returns null when no project needs it.
 */
export function retentionDelete(
  projects: ReadonlyArray<{ id: string; retentionMonths: number }>,
  now: Date,
): { query: string; params: Record<string, unknown> } | null {
  const groups = new Map<number, string[]>();
  for (const p of projects) {
    if (p.retentionMonths >= PLATFORM_RETENTION_MONTHS) continue;
    groups.set(p.retentionMonths, [...(groups.get(p.retentionMonths) ?? []), p.id]);
  }
  if (groups.size === 0) return null;
  // The job's clock, not ClickHouse's: one notion of "now" per run.
  const params: Record<string, unknown> = {
    now: now.toISOString().replace("T", " ").slice(0, 19),
  };
  const branches = [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([months, ids], i) => {
      params[`ids${i}`] = ids;
      params[`months${i}`] = months;
      return `(project_id IN {ids${i}:Array(String)} AND least(toDateTime(timestamp), toDateTime(ingested_at)) < toDateTime({now:String}, 'UTC') - toIntervalMonth({months${i}:UInt8}))`;
    });
  return {
    query: `ALTER TABLE events DELETE WHERE ${branches.join(" OR ")} SETTINGS mutations_sync = 1`,
    params,
  };
}
