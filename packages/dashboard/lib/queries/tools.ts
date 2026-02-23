import { granularityToFunction } from "@/lib/analytics/format";
import type { Granularity } from "@/lib/analytics/validation";
import { queryAnalytics } from "@/lib/clickhouse/analytics-client";
import type { LatencyBucket, TimeSeriesPoint, ToolRanking } from "./types";

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

export async function queryToolList(
  ctx: QueryContext,
  page: number,
  pageSize: number,
  sort = "callCount",
  order: "asc" | "desc" = "desc",
): Promise<{ tools: ToolRanking[]; total: number }> {
  const pf = platformFilter(ctx.platform);
  const offset = (page - 1) * pageSize;
  const validSorts: Record<string, string> = {
    callCount: "callCount",
    successRate: "successRate",
    avgLatencyMs: "avgLatencyMs",
    errorRate: "errorRate",
    toolName: "toolName",
  };
  const sortCol = validSorts[sort] ?? "callCount";

  const tools = await queryAnalytics<ToolRanking>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT
        event_name AS toolName,
        count() AS callCount,
        countIf(status = 'success') / greatest(count(), 1) AS successRate,
        avg(latency_ms) AS avgLatencyMs,
        countIf(status = 'error') / greatest(count(), 1) AS errorRate
      FROM events
      WHERE project_id = {projectId:String}
        AND event_type = 'tool_call'
        AND event_name IS NOT NULL
        AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
        ${pf}
      GROUP BY toolName
      ORDER BY ${sortCol} ${order}
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
    `,
    params: {
      projectId: ctx.projectId,
      from: ctx.from,
      to: ctx.to,
      limit: pageSize,
      offset,
      ...platformParams(ctx.platform),
    },
  });

  const countRows = await queryAnalytics<{ total: number }>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT uniqExact(event_name) AS total
      FROM events
      WHERE project_id = {projectId:String}
        AND event_type = 'tool_call'
        AND event_name IS NOT NULL
        AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
        ${pf}
    `,
    params: {
      projectId: ctx.projectId,
      from: ctx.from,
      to: ctx.to,
      ...platformParams(ctx.platform),
    },
  });

  return { tools, total: countRows[0]?.total ?? 0 };
}

export async function queryToolLatencyHistogram(
  ctx: QueryContext,
  tool: string,
): Promise<LatencyBucket[]> {
  return queryAnalytics<LatencyBucket>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT
        multiIf(
          latency_ms < 50, '0-50ms',
          latency_ms < 100, '50-100ms',
          latency_ms < 200, '100-200ms',
          latency_ms < 500, '200-500ms',
          latency_ms < 1000, '500ms-1s',
          '1s+'
        ) AS rangeLabel,
        count() AS count
      FROM events
      WHERE project_id = {projectId:String}
        AND event_type = 'tool_call'
        AND event_name = {tool:String}
        AND latency_ms IS NOT NULL
        AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
      GROUP BY rangeLabel
      ORDER BY min(latency_ms)
    `,
    params: {
      projectId: ctx.projectId,
      tool,
      from: ctx.from,
      to: ctx.to,
    },
  });
}

export async function queryToolErrorRateTimeSeries(
  ctx: QueryContext,
  tool: string,
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
        AND event_name = {tool:String}
        AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
        ${pf}
      GROUP BY bucket
      ORDER BY bucket
    `,
    params: {
      projectId: ctx.projectId,
      tool,
      from: ctx.from,
      to: ctx.to,
      ...platformParams(ctx.platform),
    },
  });
}
