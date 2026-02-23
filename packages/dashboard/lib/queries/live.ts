import { queryAnalytics } from "@/lib/clickhouse/analytics-client";
import type { LiveEvent } from "./types";

/** Strip trailing "Z" and "T" separator — ClickHouse DateTime64 rejects the timezone suffix. */
function toClickHouseDateTime(iso: string): string {
  return iso.replace("T", " ").replace("Z", "");
}

interface QueryContext {
  workspaceId: string;
  projectId: string;
}

export async function queryRecentEvents(
  ctx: QueryContext,
  since: string,
  eventType?: string,
): Promise<LiveEvent[]> {
  const typeFilter = eventType ? " AND event_type = {eventType:String}" : "";

  return queryAnalytics<LiveEvent>({
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
        error_message AS errorMessage
      FROM events
      WHERE project_id = {projectId:String}
        AND timestamp > {since:DateTime64(3)}
        ${typeFilter}
      ORDER BY timestamp DESC
      LIMIT 50
    `,
    params: {
      projectId: ctx.projectId,
      since: toClickHouseDateTime(since),
      ...(eventType ? { eventType } : {}),
    },
  });
}
