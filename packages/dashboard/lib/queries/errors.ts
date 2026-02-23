import { granularityToFunction } from "@/lib/analytics/format";
import type { Granularity } from "@/lib/analytics/validation";
import { queryAnalytics } from "@/lib/clickhouse/analytics-client";
import type { ErrorCategoryCount, ErrorListItem, TimeSeriesPoint } from "./types";

interface QueryContext {
  workspaceId: string;
  projectId: string;
  from: string;
  to: string;
  platform?: string[];
}

function platformFilter(platform?: string[]): string {
  if (!platform || platform.length === 0) return "";
  return " AND platform IN ({platforms:Array(String)})";
}

function platformParams(platform?: string[]): Record<string, unknown> {
  if (!platform || platform.length === 0) return {};
  return { platforms: platform };
}

export async function queryErrorRateTimeSeries(
  ctx: QueryContext,
  granularity: Granularity,
): Promise<TimeSeriesPoint[]> {
  const fn = granularityToFunction(granularity);
  const pf = platformFilter(ctx.platform);

  return queryAnalytics<TimeSeriesPoint>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT
        ${fn}(timestamp) AS bucket,
        countIf(status = 'error') / greatest(count(), 1) AS value
      FROM events
      WHERE project_id = {projectId:String}
        AND event_type = 'tool_call'
        AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
        ${pf}
      GROUP BY bucket
      ORDER BY bucket
    `,
    params: {
      projectId: ctx.projectId,
      from: ctx.from,
      to: ctx.to,
      ...platformParams(ctx.platform),
    },
  });
}

export async function queryErrorCategoryBreakdown(
  ctx: QueryContext,
): Promise<ErrorCategoryCount[]> {
  const pf = platformFilter(ctx.platform);

  const rows = await queryAnalytics<{ category: string; count: number }>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT
        coalesce(error_category, 'unknown') AS category,
        count() AS count
      FROM events
      WHERE project_id = {projectId:String}
        AND event_type = 'tool_call'
        AND status = 'error'
        AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
        ${pf}
      GROUP BY category
      ORDER BY count DESC
    `,
    params: {
      projectId: ctx.projectId,
      from: ctx.from,
      to: ctx.to,
      ...platformParams(ctx.platform),
    },
  });

  const total = rows.reduce((sum, r) => sum + Number(r.count), 0);
  return rows.map((r) => ({
    category: r.category,
    count: Number(r.count),
    percentage: total > 0 ? Number(r.count) / total : 0,
  }));
}

export async function queryErrorList(
  ctx: QueryContext,
  page: number,
  pageSize: number,
  errorCategory?: string,
): Promise<{ errors: ErrorListItem[]; total: number }> {
  const pf = platformFilter(ctx.platform);
  const categoryFilter = errorCategory ? " AND error_category = {errorCategory:String}" : "";
  const offset = (page - 1) * pageSize;

  const errors = await queryAnalytics<ErrorListItem>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT
        event_id AS eventId,
        timestamp,
        coalesce(event_name, '') AS toolName,
        coalesce(error_category, 'unknown') AS errorCategory,
        coalesce(error_message, '') AS errorMessage,
        coalesce(platform, 'unknown') AS platform
      FROM events
      WHERE project_id = {projectId:String}
        AND event_type = 'tool_call'
        AND status = 'error'
        AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
        ${pf}${categoryFilter}
      ORDER BY timestamp DESC
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
    `,
    params: {
      projectId: ctx.projectId,
      from: ctx.from,
      to: ctx.to,
      limit: pageSize,
      offset,
      ...(errorCategory ? { errorCategory } : {}),
      ...platformParams(ctx.platform),
    },
  });

  const countRows = await queryAnalytics<{ total: number }>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT count() AS total
      FROM events
      WHERE project_id = {projectId:String}
        AND event_type = 'tool_call'
        AND status = 'error'
        AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
        ${pf}${categoryFilter}
    `,
    params: {
      projectId: ctx.projectId,
      from: ctx.from,
      to: ctx.to,
      ...(errorCategory ? { errorCategory } : {}),
      ...platformParams(ctx.platform),
    },
  });

  return { errors, total: countRows[0]?.total ?? 0 };
}
