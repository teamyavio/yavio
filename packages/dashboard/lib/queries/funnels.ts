import { queryAnalytics } from "@/lib/clickhouse/analytics-client";
import type { FunnelStep } from "./types";

interface QueryContext {
  workspaceId: string;
  projectId: string;
  from: string;
  to: string;
}

export async function queryFunnelProgression(ctx: QueryContext): Promise<FunnelStep[]> {
  const rows = await queryAnalytics<{
    stepSequence: number;
    eventName: string;
    traceCount: number;
  }>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT
        step_sequence AS stepSequence,
        event_name AS eventName,
        uniqExact(trace_id) AS traceCount
      FROM events
      WHERE project_id = {projectId:String}
        AND event_type IN ('step', 'conversion')
        AND step_sequence IS NOT NULL
        AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
      GROUP BY stepSequence, eventName
      ORDER BY stepSequence
    `,
    params: { projectId: ctx.projectId, from: ctx.from, to: ctx.to },
  });

  if (rows.length === 0) return [];

  const maxCount = Math.max(...rows.map((r) => Number(r.traceCount)));
  return rows.map((r) => ({
    stepSequence: Number(r.stepSequence),
    eventName: r.eventName,
    count: Number(r.traceCount),
    dropOffPercent: maxCount > 0 ? 1 - Number(r.traceCount) / maxCount : 0,
  }));
}

export async function queryDropOffTraces(
  ctx: QueryContext,
  stepSequence: number,
): Promise<string[]> {
  const rows = await queryAnalytics<{ traceId: string }>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT DISTINCT trace_id AS traceId
      FROM events
      WHERE project_id = {projectId:String}
        AND event_type IN ('step', 'conversion')
        AND step_sequence = {step:UInt32}
        AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
        AND trace_id NOT IN (
          SELECT trace_id FROM events
          WHERE project_id = {projectId:String}
            AND event_type IN ('step', 'conversion')
            AND step_sequence > {step:UInt32}
            AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
        )
      LIMIT 10
    `,
    params: { projectId: ctx.projectId, step: stepSequence, from: ctx.from, to: ctx.to },
  });

  return rows.map((r) => r.traceId);
}

export async function queryTraceTimeline(
  ctx: QueryContext,
  traceId: string,
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
        step_sequence AS stepSequence,
        status,
        latency_ms AS latencyMs,
        error_category AS errorCategory
      FROM events
      WHERE project_id = {projectId:String}
        AND trace_id = {traceId:String}
      ORDER BY timestamp
    `,
    params: { projectId: ctx.projectId, traceId },
  });
}
