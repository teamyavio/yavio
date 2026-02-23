import { granularityToFunction } from "@/lib/analytics/format";
import type { Granularity } from "@/lib/analytics/validation";
import { queryAnalytics } from "@/lib/clickhouse/analytics-client";
import type { KPIResult, PlatformBreakdown, TimeSeriesPoint, ToolRanking } from "./types";

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

export async function queryOverviewKPIs(ctx: QueryContext): Promise<KPIResult[]> {
  const pf = platformFilter(ctx.platform);
  const periodMs = new Date(ctx.to).getTime() - new Date(ctx.from).getTime();
  const prevFrom = new Date(new Date(ctx.from).getTime() - periodMs)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");

  const query = `
    SELECT
      countIf(event_type = 'tool_call' AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}) AS invocations,
      countIf(event_type = 'tool_call' AND timestamp >= {prevFrom:DateTime64(3)} AND timestamp < {from:DateTime64(3)}) AS prev_invocations,
      uniqExactIf(session_id, timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}) AS sessions,
      uniqExactIf(session_id, timestamp >= {prevFrom:DateTime64(3)} AND timestamp < {from:DateTime64(3)}) AS prev_sessions,
      countIf(event_type = 'tool_call' AND status = 'error' AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}) /
        greatest(countIf(event_type = 'tool_call' AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}), 1) AS error_rate,
      countIf(event_type = 'tool_call' AND status = 'error' AND timestamp >= {prevFrom:DateTime64(3)} AND timestamp < {from:DateTime64(3)}) /
        greatest(countIf(event_type = 'tool_call' AND timestamp >= {prevFrom:DateTime64(3)} AND timestamp < {from:DateTime64(3)}), 1) AS prev_error_rate,
      avgIf(latency_ms, event_type = 'tool_call' AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}) AS avg_latency,
      avgIf(latency_ms, event_type = 'tool_call' AND timestamp >= {prevFrom:DateTime64(3)} AND timestamp < {from:DateTime64(3)}) AS prev_avg_latency,
      countIf(event_type = 'conversion' AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}) AS conversions,
      countIf(event_type = 'conversion' AND timestamp >= {prevFrom:DateTime64(3)} AND timestamp < {from:DateTime64(3)}) AS prev_conversions,
      sumIf(conversion_value, event_type = 'conversion' AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}) AS revenue,
      sumIf(conversion_value, event_type = 'conversion' AND timestamp >= {prevFrom:DateTime64(3)} AND timestamp < {from:DateTime64(3)}) AS prev_revenue
    FROM events
    WHERE project_id = {projectId:String}
      AND timestamp >= {prevFrom:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
      ${pf}
  `;

  const rows = await queryAnalytics<Record<string, number>>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query,
    params: {
      projectId: ctx.projectId,
      from: ctx.from,
      to: ctx.to,
      prevFrom,
      ...platformParams(ctx.platform),
    },
  });

  const r = rows[0] ?? {};
  return [
    {
      label: "Invocations",
      value: r.invocations ?? 0,
      previousValue: r.prev_invocations,
      format: "number",
    },
    { label: "Sessions", value: r.sessions ?? 0, previousValue: r.prev_sessions, format: "number" },
    {
      label: "Error Rate",
      value: r.error_rate ?? 0,
      previousValue: r.prev_error_rate,
      format: "percent",
    },
    {
      label: "Avg Latency",
      value: r.avg_latency ?? 0,
      previousValue: r.prev_avg_latency,
      format: "latency",
    },
    {
      label: "Conversions",
      value: r.conversions ?? 0,
      previousValue: r.prev_conversions,
      format: "number",
    },
    { label: "Revenue", value: r.revenue ?? 0, previousValue: r.prev_revenue, format: "currency" },
  ];
}

export async function queryInvocationsTimeSeries(
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
        count() AS value
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

export async function queryPlatformBreakdown(ctx: QueryContext): Promise<PlatformBreakdown[]> {
  const pf = platformFilter(ctx.platform);

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
        AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
        ${pf}
      GROUP BY platform
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
    platform: r.platform,
    count: Number(r.count),
    percentage: total > 0 ? Number(r.count) / total : 0,
  }));
}

export async function queryTopTools(ctx: QueryContext): Promise<ToolRanking[]> {
  const pf = platformFilter(ctx.platform);

  return queryAnalytics<ToolRanking>({
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
      ORDER BY callCount DESC
      LIMIT 10
    `,
    params: {
      projectId: ctx.projectId,
      from: ctx.from,
      to: ctx.to,
      ...platformParams(ctx.platform),
    },
  });
}
