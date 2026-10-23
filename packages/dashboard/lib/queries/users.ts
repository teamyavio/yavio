import { fillTimeBuckets } from "@/lib/analytics/fill-buckets";
import { granularityToFunction } from "@/lib/analytics/format";
import type { Granularity } from "@/lib/analytics/validation";
import { queryAnalytics } from "@/lib/clickhouse/analytics-client";
import type {
  ActiveUsersPoint,
  NewVsReturningPoint,
  RetentionCohort,
  StickinessBucket,
  UserListItem,
} from "./types";

interface QueryContext {
  workspaceId: string;
  projectId: string;
  from: string;
  to: string;
}

/**
 * Who a user is (#89, #145), per event:
 *   coalesce(user_id, the first user_id identified in its session,
 *            the user_id stitched to its subject_id, subject_id)
 *
 * - user_id: what the integrator passed to identify(). An event's own id is
 *   never overwritten.
 * - Session stitch (#145): identify() stamps user_id only on the events of
 *   the SDK process that called it, from that call on. A stateless fleet
 *   serves one conversation from several instances, so the others' events
 *   — and every event before the identify — carry no user_id. Each
 *   session_id is mapped to the FIRST user_id an identify row gave it
 *   (argMin over (timestamp, event_id)): the SDK's one-user-per-session rule
 *   (YAVIO-1302) and what a single process would have produced, so a later
 *   identify never re-attributes history. Only identify rows are read — a
 *   primary-key range, a few percent of the events. An event without a
 *   session never maps to anyone.
 * - subject_id: the platform's stable pseudonymous per-user-per-app id
 *   (ChatGPT's openai/subject), so apps that never call identify() still have
 *   user metrics.
 * - Subject stitch: events before identify() carry only subject_id, events
 *   after it carry user_id. Each subject_id is mapped to the user_id last seen
 *   with it, so such a person counts once, not twice. The session map comes
 *   first: an identify in the same conversation is direct evidence, the
 *   subject an inference across conversations.
 * - Never session_id as the key: a session is not a person. An empty user_id
 *   is not one either.
 *
 * All user metrics come straight from events, which holds the same 13 months
 * a per-user summary would; users_mv / sessions_mv merged wrongly and are
 * dropped (#89). "First seen" therefore means within that window. The map is
 * computed per query, not stored: the identify rows carry it, so tenant
 * erasure, the per-project retention delete and the TTL take it with them.
 *
 * #85's statistics job counts users with the same key, so tier 1 and tier 2
 * agree. Aliases never shadow a column a WHERE refers to: ClickHouse resolves
 * the alias first.
 *
 * A windowed COUNT stitches from the window it reads (#112), both maps: the
 * mapping only has to cover the sessions and subject_ids that appear there,
 * and a person seen as subject and as user_id within the window is still one
 * person. Without the bound, every users-page query aggregated the whole
 * project's events before its own time filter applied — several times per
 * page view, and growing with the 13 months now kept. Queries that name a
 * person — the all-time list, first seen, retention cohorts, and the detail
 * of one user — keep the full mapping, so the list and the detail agree on
 * whose the unstamped events are. "A later identify never re-attributes
 * history" holds for that full mapping only: in a windowed count a session
 * whose first identify falls before the window goes to the first id
 * identified inside it, if there is one (#145 review round 1).
 */
export interface TimeWindow {
  /** SQL expressions; the window is [from, to). */
  from: string;
  to: string;
}

const bound = (column: string, window?: TimeWindow): string =>
  window ? `AND ${column} >= ${window.from} AND ${column} < ${window.to}` : "";

/**
 * `rows`: an extra condition on the keyed rows, on `e.` columns (e.g.
 * `AND e.event_type = 'tool_call'`), so a caller that needs only some rows
 * joins only those — a filter outside the CTE runs after the join.
 */
export function keyedEvents({
  events,
  stitch,
  rows = "",
}: { events?: TimeWindow; stitch?: TimeWindow; rows?: string } = {}): string {
  return `
      session_map AS (
        SELECT session_id AS stitched_session,
               argMin(assumeNotNull(user_id), (timestamp, event_id)) AS session_user_id
        FROM events
        WHERE project_id = {projectId:String}
          AND event_type = 'identify'
          AND user_id IS NOT NULL AND user_id != ''
          AND session_id != ''
          ${bound("timestamp", stitch)}
        GROUP BY stitched_session
      ),
      stitch AS (
        SELECT assumeNotNull(subject_id) AS stitched_subject,
               argMax(assumeNotNull(user_id), timestamp) AS mapped_user_id
        FROM events
        WHERE project_id = {projectId:String}
          AND subject_id IS NOT NULL AND subject_id != ''
          AND user_id IS NOT NULL AND user_id != ''
          ${bound("timestamp", stitch)}
        GROUP BY stitched_subject
      ),
      keyed AS (
        SELECT e.*,
               coalesce(nullIf(e.user_id, ''), nullIf(m.session_user_id, ''),
                        nullIf(s.mapped_user_id, ''), nullIf(e.subject_id, '')) AS user_key
        FROM events AS e
        LEFT JOIN session_map AS m ON m.stitched_session = e.session_id
        LEFT JOIN stitch AS s ON s.stitched_subject = ifNull(e.subject_id, '')
        WHERE e.project_id = {projectId:String} ${bound("e.timestamp", events)} ${rows}
      )`;
}

export async function queryUserList(
  ctx: QueryContext,
  page: number,
  pageSize: number,
  sort = "lastSeen",
  order: "asc" | "desc" = "desc",
): Promise<{ users: UserListItem[]; total: number }> {
  const offset = (page - 1) * pageSize;
  const validSorts: Record<string, string> = {
    lastSeen: "lastSeen",
    firstSeen: "firstSeen",
    totalEvents: "totalEvents",
    totalSessions: "totalSessions",
    totalToolCalls: "totalToolCalls",
    totalConversions: "totalConversions",
    totalRevenue: "totalRevenue",
  };
  const sortCol = validSorts[sort] ?? "lastSeen";
  const sortOrder = order === "asc" ? "asc" : "desc";

  const users = await queryAnalytics<UserListItem>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      WITH ${keyedEvents()}
      SELECT
        user_key AS userId,
        min(timestamp) AS firstSeen,
        max(timestamp) AS lastSeen,
        count() AS totalEvents,
        uniqExact(session_id) AS totalSessions,
        countIf(event_type = 'tool_call') AS totalToolCalls,
        countIf(event_type = 'conversion') AS totalConversions,
        sumIf(ifNull(conversion_value, 0), event_type = 'conversion') AS totalRevenue,
        argMax(ifNull(platform, ''), timestamp) AS lastPlatform
      FROM keyed
      WHERE user_key IS NOT NULL
      GROUP BY user_key
      ORDER BY ${sortCol} ${sortOrder}, userId
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
    `,
    params: { projectId: ctx.projectId, limit: pageSize, offset },
  });

  const countRows = await queryAnalytics<{ total: number }>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      WITH ${keyedEvents()}
      SELECT uniqExact(user_key) AS total FROM keyed WHERE user_key IS NOT NULL
    `,
    params: { projectId: ctx.projectId },
  });

  return { users, total: Number(countRows[0]?.total ?? 0) };
}

/**
 * Users first seen in the selected range, by period, and how many of them were
 * active again 0, 1, 2, ... periods later (within the range). The array is
 * indexed by that offset, with 0 for an offset nobody returned in.
 *
 * It used to fail on every call: `groupArray(x ORDER BY y)` is Postgres syntax
 * (#89). The order is now built with arraySort over (offset, count) tuples.
 */
export async function queryRetentionCohorts(
  ctx: QueryContext,
  period: "day" | "week" | "month" = "week",
): Promise<RetentionCohort[]> {
  const fn =
    period === "day" ? "toStartOfDay" : period === "week" ? "toStartOfWeek" : "toStartOfMonth";
  const interval = period === "day" ? "DAY" : period === "week" ? "WEEK" : "MONTH";

  return queryAnalytics<RetentionCohort>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      WITH ${keyedEvents()},
      firsts AS (
        SELECT user_key AS person, ${fn}(min(timestamp)) AS cohort_period
        FROM keyed WHERE user_key IS NOT NULL
        GROUP BY person
      ),
      cohorts AS (
        SELECT person, cohort_period FROM firsts
        WHERE cohort_period >= ${fn}({from:DateTime64(3)}) AND cohort_period < {to:DateTime64(3)}
      ),
      activity AS (
        SELECT DISTINCT user_key AS person, ${fn}(timestamp) AS activity_period
        FROM keyed
        WHERE user_key IS NOT NULL
          AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
      ),
      sizes AS (
        SELECT cohort_period, uniqExact(person) AS cohort_size FROM cohorts GROUP BY cohort_period
      ),
      per_offset AS (
        SELECT c.cohort_period AS cohort_period,
               dateDiff('${interval}', c.cohort_period, a.activity_period) AS period_offset,
               uniqExact(c.person) AS period_count
        FROM cohorts AS c
        INNER JOIN activity AS a ON a.person = c.person
        WHERE a.activity_period >= c.cohort_period
        GROUP BY cohort_period, period_offset
      )
      SELECT
        cohortPeriod,
        cohortSize,
        arrayMap(i -> toUInt32(arrayFirst(x -> x.1 = i, pairs).2), range(toUInt32(maxOffset + 1)))
          AS retentionByPeriod
      FROM (
        SELECT
          toString(s.cohort_period) AS cohortPeriod,
          toUInt32(s.cohort_size) AS cohortSize,
          arraySort(x -> x.1, groupArray((p.period_offset, p.period_count))) AS pairs,
          max(p.period_offset) AS maxOffset
        FROM sizes AS s
        LEFT JOIN per_offset AS p ON p.cohort_period = s.cohort_period
        GROUP BY s.cohort_period, s.cohort_size
      )
      ORDER BY cohortPeriod
    `,
    params: { projectId: ctx.projectId, from: ctx.from, to: ctx.to },
  });
}

/**
 * Active users per bucket: users active in the bucket's first day (or hour),
 * and in the 7 and 30 days ending with it — the same windows as before.
 *
 * Built from one row per person and day, fanned out over the 30 days each
 * activity counts towards, instead of a CROSS JOIN of every bucket with every
 * event, which got expensive over long ranges (#85 step 7).
 */
export async function queryActiveUsers(
  ctx: QueryContext,
  granularity: Granularity,
): Promise<ActiveUsersPoint[]> {
  const fn = granularityToFunction(granularity);
  // 30 days before the range, for the rolling WAU/MAU windows.
  const window = { from: "({from:DateTime64(3)} - INTERVAL 30 DAY)", to: "{to:DateTime64(3)}" };
  const inRange = "timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}";

  const query =
    granularity === "hour"
      ? `
      WITH ${keyedEvents({ events: window, stitch: window })},
      act AS (
        SELECT DISTINCT user_key AS person, toStartOfHour(timestamp) AS active_hour
        FROM keyed WHERE user_key IS NOT NULL
      ),
      buckets AS (
        SELECT DISTINCT toStartOfHour(timestamp) AS bucket_hour
        FROM keyed WHERE user_key IS NOT NULL AND ${inRange}
      )
      SELECT
        b.bucket_hour AS bucket,
        uniqExactIf(a.person, a.active_hour = b.bucket_hour) AS dau,
        uniqExactIf(a.person, a.active_hour >= b.bucket_hour - INTERVAL 6 DAY
                              AND a.active_hour <= b.bucket_hour) AS wau,
        uniqExactIf(a.person, a.active_hour >= b.bucket_hour - INTERVAL 29 DAY
                              AND a.active_hour <= b.bucket_hour) AS mau
      FROM buckets AS b CROSS JOIN act AS a
      GROUP BY b.bucket_hour
      ORDER BY bucket
    `
      : `
      WITH ${keyedEvents({ events: window, stitch: window })},
      act AS (
        SELECT DISTINCT user_key AS person, toDate(timestamp) AS active_day
        FROM keyed WHERE user_key IS NOT NULL
      ),
      buckets AS (
        SELECT DISTINCT toDate(${fn}(timestamp)) AS bucket_day
        FROM keyed WHERE user_key IS NOT NULL AND ${inRange}
      )
      SELECT
        ${granularity === "day" ? "toDateTime(window_day, 'UTC')" : "window_day"} AS bucket,
        dau, wau, mau
      FROM (
        SELECT
          addDays(active_day, days_back) AS window_day,
          uniqExactIf(person, days_back = 0) AS dau,
          uniqExactIf(person, days_back < 7) AS wau,
          uniqExact(person) AS mau
        FROM act ARRAY JOIN range(30) AS days_back
        WHERE addDays(active_day, days_back) IN (SELECT bucket_day FROM buckets)
        GROUP BY window_day
      )
      ORDER BY bucket
    `;

  const rows = await queryAnalytics<ActiveUsersPoint>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query,
    params: { projectId: ctx.projectId, from: ctx.from, to: ctx.to },
  });
  return fillTimeBuckets(rows, ctx.from, ctx.to, granularity, (bucket) => ({
    bucket,
    dau: 0,
    wau: 0,
    mau: 0,
  }));
}

export async function queryNewVsReturning(
  ctx: QueryContext,
  granularity: Granularity,
): Promise<NewVsReturningPoint[]> {
  const fn = granularityToFunction(granularity);

  const rows = await queryAnalytics<NewVsReturningPoint>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      WITH ${keyedEvents()},
      firsts AS (
        SELECT user_key AS person, ${fn}(min(timestamp)) AS first_period
        FROM keyed WHERE user_key IS NOT NULL
        GROUP BY person
      )
      SELECT
        ${fn}(k.timestamp) AS bucket,
        uniqExactIf(k.user_key, f.first_period = ${fn}(k.timestamp)) AS newUsers,
        uniqExactIf(k.user_key, f.first_period < ${fn}(k.timestamp)) AS returningUsers
      FROM keyed AS k
      INNER JOIN firsts AS f ON f.person = k.user_key
      WHERE k.timestamp >= {from:DateTime64(3)} AND k.timestamp < {to:DateTime64(3)}
      GROUP BY bucket
      ORDER BY bucket
    `,
    params: { projectId: ctx.projectId, from: ctx.from, to: ctx.to },
  });
  return fillTimeBuckets(rows, ctx.from, ctx.to, granularity, (bucket) => ({
    bucket,
    newUsers: 0,
    returningUsers: 0,
  }));
}

export async function queryUserDetail(
  ctx: QueryContext,
  userId: string,
): Promise<Record<string, unknown>[]> {
  return queryAnalytics<Record<string, unknown>>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      WITH ${keyedEvents({ events: { from: "{from:DateTime64(3)}", to: "{to:DateTime64(3)}" } })}
      SELECT
        event_id AS eventId,
        event_type AS eventType,
        event_name AS eventName,
        timestamp,
        session_id AS sessionId,
        trace_id AS traceId,
        status,
        latency_ms AS latencyMs,
        error_category AS errorCategory,
        error_message AS errorMessage,
        platform
      FROM keyed
      WHERE user_key = {userId:String}
      ORDER BY timestamp DESC
      LIMIT 200
    `,
    params: { projectId: ctx.projectId, userId, from: ctx.from, to: ctx.to },
  });
}
