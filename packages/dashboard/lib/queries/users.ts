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

  const users = await queryAnalytics<UserListItem>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT
        user_id AS userId,
        min(first_seen) AS firstSeen,
        max(last_seen) AS lastSeen,
        sum(total_events) AS totalEvents,
        sum(total_sessions) AS totalSessions,
        sum(total_tool_calls) AS totalToolCalls,
        sum(total_conversions) AS totalConversions,
        sum(total_revenue) AS totalRevenue,
        anyLast(last_platform) AS lastPlatform
      FROM users_mv FINAL
      WHERE project_id = {projectId:String}
      GROUP BY user_id
      ORDER BY ${sortCol} ${order}
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
    `,
    params: { projectId: ctx.projectId, limit: pageSize, offset },
  });

  const countRows = await queryAnalytics<{ total: number }>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT uniqExact(user_id) AS total
      FROM users_mv FINAL
      WHERE project_id = {projectId:String}
    `,
    params: { projectId: ctx.projectId },
  });

  return { users, total: countRows[0]?.total ?? 0 };
}

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
      WITH cohort_users AS (
        SELECT
          user_id,
          ${fn}(min(first_seen)) AS cohort_period
        FROM users_mv FINAL
        WHERE project_id = {projectId:String}
        GROUP BY user_id
      ),
      activity AS (
        SELECT
          user_id,
          ${fn}(timestamp) AS activity_period
        FROM events
        WHERE project_id = {projectId:String}
          AND user_id IS NOT NULL AND user_id != ''
          AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
        GROUP BY user_id, activity_period
      )
      SELECT
        toString(c.cohort_period) AS cohortPeriod,
        count(DISTINCT c.user_id) AS cohortSize,
        groupArray(period_count ORDER BY period_offset) AS retentionByPeriod
      FROM cohort_users c
      LEFT JOIN (
        SELECT
          c2.cohort_period,
          dateDiff('${interval}', c2.cohort_period, a.activity_period) AS period_offset,
          count(DISTINCT a.user_id) AS period_count
        FROM cohort_users c2
        INNER JOIN activity a ON c2.user_id = a.user_id
        GROUP BY c2.cohort_period, period_offset
        ORDER BY period_offset
      ) sub ON c.cohort_period = sub.cohort_period
      GROUP BY c.cohort_period
      ORDER BY c.cohort_period
    `,
    params: { projectId: ctx.projectId, from: ctx.from, to: ctx.to },
  });
}

export async function queryActiveUsers(
  ctx: QueryContext,
  granularity: Granularity,
): Promise<ActiveUsersPoint[]> {
  const fn = granularityToFunction(granularity);
  const interval = granularity === "hour" ? "HOUR" : "DAY";

  return queryAnalytics<ActiveUsersPoint>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      WITH buckets AS (
        SELECT ${fn}(timestamp) AS bucket
        FROM events
        WHERE project_id = {projectId:String}
          AND user_id IS NOT NULL AND user_id != ''
          AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
        GROUP BY bucket
      )
      SELECT
        b.bucket,
        uniqExactIf(e.user_id,
          e.timestamp >= b.bucket AND e.timestamp < b.bucket + INTERVAL 1 ${interval}
        ) AS dau,
        uniqExactIf(e.user_id,
          e.timestamp >= b.bucket - INTERVAL 6 DAY
          AND e.timestamp < b.bucket + INTERVAL 1 ${interval}
        ) AS wau,
        uniqExactIf(e.user_id,
          e.timestamp >= b.bucket - INTERVAL 29 DAY
          AND e.timestamp < b.bucket + INTERVAL 1 ${interval}
        ) AS mau
      FROM buckets b
      CROSS JOIN events e
      WHERE e.project_id = {projectId:String}
        AND e.user_id IS NOT NULL AND e.user_id != ''
        AND e.timestamp >= ({from:DateTime64(3)} - INTERVAL 30 DAY)
        AND e.timestamp < {to:DateTime64(3)}
      GROUP BY b.bucket
      ORDER BY b.bucket
    `,
    params: { projectId: ctx.projectId, from: ctx.from, to: ctx.to },
  });
}

export async function queryNewVsReturning(
  ctx: QueryContext,
  granularity: Granularity,
): Promise<NewVsReturningPoint[]> {
  const fn = granularityToFunction(granularity);

  return queryAnalytics<NewVsReturningPoint>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      WITH first_periods AS (
        SELECT
          user_id,
          ${fn}(min(first_seen)) AS first_period
        FROM users_mv FINAL
        WHERE project_id = {projectId:String}
        GROUP BY user_id
      )
      SELECT
        ${fn}(e.timestamp) AS bucket,
        countDistinctIf(e.user_id, fp.first_period = ${fn}(e.timestamp)) AS newUsers,
        countDistinctIf(e.user_id, fp.first_period < ${fn}(e.timestamp)) AS returningUsers
      FROM events e
      LEFT JOIN first_periods fp ON e.user_id = fp.user_id
      WHERE e.project_id = {projectId:String}
        AND e.user_id IS NOT NULL AND e.user_id != ''
        AND e.timestamp >= {from:DateTime64(3)} AND e.timestamp < {to:DateTime64(3)}
      GROUP BY bucket
      ORDER BY bucket
    `,
    params: { projectId: ctx.projectId, from: ctx.from, to: ctx.to },
  });
}

export async function queryUserDetail(
  ctx: QueryContext,
  userId: string,
): Promise<Record<string, unknown>[]> {
  return queryAnalytics<Record<string, unknown>>({
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
        status,
        latency_ms AS latencyMs,
        error_category AS errorCategory,
        error_message AS errorMessage,
        platform
      FROM events
      WHERE project_id = {projectId:String}
        AND user_id = {userId:String}
        AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
      ORDER BY timestamp DESC
      LIMIT 200
    `,
    params: { projectId: ctx.projectId, userId, from: ctx.from, to: ctx.to },
  });
}
