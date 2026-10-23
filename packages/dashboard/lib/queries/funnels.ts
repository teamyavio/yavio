import { queryAnalytics } from "@/lib/clickhouse/analytics-client";
import type { FunnelStep } from "./types";

interface QueryContext {
  workspaceId: string;
  projectId: string;
  from: string;
  to: string;
}

/**
 * Funnels count conversations, their steps numbered in the order they
 * happened (#145).
 *
 * step_sequence is the SDK's counter per session per PROCESS: it starts at 1
 * again on every instance of a stateless fleet, after an LRU eviction, and on
 * every widget load. Grouped by it, one conversation served by three
 * instances was three attempts at position 1, and every multi-call funnel
 * that went on elsewhere was a drop-off. A step's position is now its rank
 * among its session's steps: row_number() over (timestamp, step_sequence,
 * event_id).
 *
 * - The rank counts the session's steps before the range's end, also those
 *   before its start: a session that straddles the start keeps its
 *   positions. Only the steps inside the range are counted.
 * - One process gives exactly what grouping by step_sequence gave: its
 *   steps are stamped in order, and step_sequence breaks a tie within one
 *   millisecond.
 * - Rows are deduplicated by event_id (events is a ReplacingMergeTree: an
 *   unmerged copy would take a position of its own).
 * - A lost step moves the later ones up instead of leaving a hole.
 * - A step without a session keeps the old rule: its trace is the attempt,
 *   step_sequence its position. No SDK writes one.
 * - Not covered: clock skew between hosts, ingest's +5 min clamp, a wall
 *   clock stepping backwards, the browser clock of widget steps.
 * - Conversions carry no step_sequence and stay out, as before.
 */
const RANKED_STEPS = `
      in_range AS (
        SELECT DISTINCT session_id
        FROM events
        WHERE project_id = {projectId:String}
          AND event_type IN ('step', 'conversion')
          AND step_sequence IS NOT NULL
          AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
      ),
      steps AS (
        SELECT event_id, session_id, trace_id, event_name, timestamp,
               assumeNotNull(step_sequence) AS seq
        FROM events
        WHERE project_id = {projectId:String}
          AND event_type IN ('step', 'conversion')
          AND step_sequence IS NOT NULL
          AND timestamp < {to:DateTime64(3)}
          AND session_id IN (SELECT session_id FROM in_range)
        LIMIT 1 BY event_id
      ),
      ranked AS (
        SELECT if(session_id = '', concat('trace:', trace_id), concat('session:', session_id)) AS attempt,
               trace_id, event_name, timestamp,
               if(session_id = '', seq,
                  row_number() OVER (PARTITION BY session_id ORDER BY timestamp, seq, event_id)) AS step_position
        FROM steps
      )`;

export async function queryFunnelProgression(ctx: QueryContext): Promise<FunnelStep[]> {
  const rows = await queryAnalytics<{
    stepSequence: number;
    eventName: string;
    attempts: number;
  }>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      WITH ${RANKED_STEPS}
      SELECT
        step_position AS stepSequence,
        event_name AS eventName,
        uniqExact(attempt) AS attempts
      FROM ranked
      WHERE timestamp >= {from:DateTime64(3)}
      GROUP BY stepSequence, eventName
      ORDER BY stepSequence, eventName
    `,
    params: { projectId: ctx.projectId, from: ctx.from, to: ctx.to },
  });

  if (rows.length === 0) return [];

  const maxCount = Math.max(...rows.map((r) => Number(r.attempts)));
  return rows.map((r) => ({
    stepSequence: Number(r.stepSequence),
    eventName: r.eventName,
    count: Number(r.attempts),
    dropOffPercent: maxCount > 0 ? 1 - Number(r.attempts) / maxCount : 0,
  }));
}

/**
 * Up to 10 attempts whose last step in the range is at `stepSequence`, most
 * recent first — by session, so a funnel that went on in another trace or on
 * another instance is not a drop-off. Each is returned as the trace of its
 * last step, which queryTraceTimeline opens.
 */
export async function queryDropOffTraces(
  ctx: QueryContext,
  stepSequence: number,
): Promise<string[]> {
  const rows = await queryAnalytics<{ traceId: string }>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      WITH ${RANKED_STEPS},
      last_steps AS (
        SELECT attempt,
               max(step_position) AS last_position,
               argMax(trace_id, (step_position, timestamp)) AS last_trace,
               max(timestamp) AS last_at
        FROM ranked
        WHERE timestamp >= {from:DateTime64(3)}
        GROUP BY attempt
      )
      SELECT last_trace AS traceId
      FROM last_steps
      WHERE last_position = {step:UInt32}
      ORDER BY last_at DESC, traceId
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
      -- Steps stamped in the same millisecond keep their recorded order.
      ORDER BY timestamp, step_sequence, event_id
    `,
    params: { projectId: ctx.projectId, traceId },
  });
}
