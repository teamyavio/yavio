import { granularityToFunction } from "@/lib/analytics/format";
import type { Granularity } from "@/lib/analytics/validation";
import { queryAnalytics } from "@/lib/clickhouse/analytics-client";
import type {
  ErrorCategoryCount,
  KPIResult,
  LatencyBucket,
  LatencyPercentilePoint,
  PlatformBreakdown,
  TimeSeriesPoint,
  ToolInvocation,
  ToolRegistryEntry,
} from "./types";

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

export async function queryToolDetailKPIs(ctx: QueryContext, tool: string): Promise<KPIResult[]> {
  const pf = platformFilter(ctx.platform);
  const periodMs = new Date(ctx.to).getTime() - new Date(ctx.from).getTime();
  const prevFrom = new Date(new Date(ctx.from).getTime() - periodMs)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");

  const rows = await queryAnalytics<Record<string, number>>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT
        countIf(timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}) AS totalCalls,
        countIf(timestamp >= {prevFrom:DateTime64(3)} AND timestamp < {from:DateTime64(3)}) AS prevTotalCalls,
        countIf(status = 'success' AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)})
          / greatest(countIf(timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}), 1) AS successRate,
        countIf(status = 'success' AND timestamp >= {prevFrom:DateTime64(3)} AND timestamp < {from:DateTime64(3)})
          / greatest(countIf(timestamp >= {prevFrom:DateTime64(3)} AND timestamp < {from:DateTime64(3)}), 1) AS prevSuccessRate,
        avgIf(latency_ms, timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}) AS avgLatencyMs,
        avgIf(latency_ms, timestamp >= {prevFrom:DateTime64(3)} AND timestamp < {from:DateTime64(3)}) AS prevAvgLatencyMs,
        countIf(status = 'error' AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)})
          / greatest(countIf(timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}), 1) AS errorRate,
        countIf(status = 'error' AND timestamp >= {prevFrom:DateTime64(3)} AND timestamp < {from:DateTime64(3)})
          / greatest(countIf(timestamp >= {prevFrom:DateTime64(3)} AND timestamp < {from:DateTime64(3)}), 1) AS prevErrorRate
      FROM events
      WHERE project_id = {projectId:String}
        AND event_type = 'tool_call'
        AND event_name = {tool:String}
        AND timestamp >= {prevFrom:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
        ${pf}
    `,
    params: {
      projectId: ctx.projectId,
      tool,
      from: ctx.from,
      to: ctx.to,
      prevFrom,
      ...platformParams(ctx.platform),
    },
  });

  const r = rows[0] ?? {};
  return [
    {
      label: "Total Calls",
      value: r.totalCalls ?? 0,
      previousValue: r.prevTotalCalls,
      format: "number",
    },
    {
      label: "Success Rate",
      value: r.successRate ?? 0,
      previousValue: r.prevSuccessRate,
      format: "percent",
    },
    {
      label: "Avg Latency",
      value: r.avgLatencyMs ?? 0,
      previousValue: r.prevAvgLatencyMs,
      format: "latency",
    },
    {
      label: "Error Rate",
      value: r.errorRate ?? 0,
      previousValue: r.prevErrorRate,
      format: "percent",
    },
  ];
}

export async function queryToolCallVolume(
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
        count() AS value
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

export async function queryToolLatencyPercentiles(
  ctx: QueryContext,
  tool: string,
  granularity: Granularity,
): Promise<LatencyPercentilePoint[]> {
  const fn = granularityToFunction(granularity);
  const pf = platformFilter(ctx.platform);

  return queryAnalytics<LatencyPercentilePoint>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT
        ${fn}(timestamp) AS bucket,
        quantile(0.5)(latency_ms) AS p50,
        quantile(0.95)(latency_ms) AS p95,
        quantile(0.99)(latency_ms) AS p99
      FROM events
      WHERE project_id = {projectId:String}
        AND event_type = 'tool_call'
        AND event_name = {tool:String}
        AND latency_ms IS NOT NULL
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

export async function queryToolErrorCategories(
  ctx: QueryContext,
  tool: string,
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
        AND event_name = {tool:String}
        AND status = 'error'
        AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
        ${pf}
      GROUP BY category
      ORDER BY count DESC
    `,
    params: {
      projectId: ctx.projectId,
      tool,
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

export async function queryToolPlatformBreakdown(
  ctx: QueryContext,
  tool: string,
): Promise<PlatformBreakdown[]> {
  const rows = await queryAnalytics<{ platform: string; count: number }>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT
        coalesce(platform, 'unknown') AS platform,
        count() AS count
      FROM events
      WHERE project_id = {projectId:String}
        AND event_type = 'tool_call'
        AND event_name = {tool:String}
        AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
      GROUP BY platform
      ORDER BY count DESC
    `,
    params: {
      projectId: ctx.projectId,
      tool,
      from: ctx.from,
      to: ctx.to,
    },
  });

  const total = rows.reduce((sum, r) => sum + Number(r.count), 0);
  return rows.map((r) => ({
    platform: r.platform,
    count: Number(r.count),
    percentage: total > 0 ? Number(r.count) / total : 0,
  }));
}

export async function queryToolRecentInvocations(
  ctx: QueryContext,
  tool: string,
  page: number,
  pageSize: number,
): Promise<{ invocations: ToolInvocation[]; total: number }> {
  const pf = platformFilter(ctx.platform);
  const offset = (page - 1) * pageSize;

  const invocations = await queryAnalytics<ToolInvocation>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT
        event_id AS eventId,
        timestamp,
        trace_id AS traceId,
        session_id AS sessionId,
        user_id AS userId,
        coalesce(status, 'unknown') AS status,
        latency_ms AS latencyMs,
        coalesce(platform, 'unknown') AS platform,
        error_category AS errorCategory,
        error_message AS errorMessage,
        is_retry AS isRetry,
        input_values AS inputValues,
        output_content AS outputContent
      FROM events
      WHERE project_id = {projectId:String}
        AND event_type = 'tool_call'
        AND event_name = {tool:String}
        AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
        ${pf}
      ORDER BY timestamp DESC
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
    `,
    params: {
      projectId: ctx.projectId,
      tool,
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
      SELECT count() AS total
      FROM events
      WHERE project_id = {projectId:String}
        AND event_type = 'tool_call'
        AND event_name = {tool:String}
        AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
        ${pf}
    `,
    params: {
      projectId: ctx.projectId,
      tool,
      from: ctx.from,
      to: ctx.to,
      ...platformParams(ctx.platform),
    },
  });

  return { invocations, total: countRows[0]?.total ?? 0 };
}

export async function queryToolRegistryEntry(
  ctx: QueryContext,
  tool: string,
): Promise<ToolRegistryEntry | null> {
  const rows = await queryAnalytics<ToolRegistryEntry>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT
        tool_name AS toolName,
        description,
        input_schema AS inputSchema,
        registered_at AS registeredAt,
        updated_at AS updatedAt
      FROM tool_registry FINAL
      WHERE project_id = {projectId:String}
        AND tool_name = {tool:String}
    `,
    params: {
      projectId: ctx.projectId,
      tool,
    },
  });

  return rows[0] ?? null;
}
