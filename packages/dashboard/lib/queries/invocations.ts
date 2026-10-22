import { queryAnalytics } from "@/lib/clickhouse/analytics-client";
import { HAS_INTENT_SQL } from "./intents";
import type { InvocationFeedItem } from "./types";

interface QueryContext {
  workspaceId: string;
  projectId: string;
  from: string;
  to: string;
  platform?: string[];
}

export interface InvocationFeedOptions {
  /** Only calls that carried an intent. */
  hasIntent?: boolean;
  /** Only calls of this tool (exact event_name). */
  tool?: string;
  /** Only calls with this status. */
  status?: "success" | "error";
}

/**
 * Project-wide paginated list of tool calls, newest first, with the intent
 * inline (#44). Unlike the intents feed it keeps rows without an intent —
 * intent capture is opt-in and not every client fills optional parameters —
 * so the intent column is simply empty for them.
 *
 * The user column is the id on the event itself (user_id, else subject_id).
 * The Users page additionally stitches a subject_id to the user_id it was
 * later identified as; a per-row list does not need that join.
 */
export async function queryInvocationFeed(
  ctx: QueryContext,
  page: number,
  pageSize: number,
  options: InvocationFeedOptions = {},
): Promise<{ invocations: InvocationFeedItem[]; total: number }> {
  const offset = (page - 1) * pageSize;

  const conditions = [
    "project_id = {projectId:String}",
    "event_type = 'tool_call'",
    "timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}",
  ];
  const params: Record<string, unknown> = {
    projectId: ctx.projectId,
    from: ctx.from,
    to: ctx.to,
  };

  if (ctx.platform && ctx.platform.length > 0) {
    conditions.push("platform IN ({platforms:Array(String)})");
    params.platforms = ctx.platform;
  }
  if (options.hasIntent) conditions.push(HAS_INTENT_SQL);
  if (options.tool) {
    conditions.push("event_name = {tool:String}");
    params.tool = options.tool;
  }
  if (options.status) {
    conditions.push("status = {status:String}");
    params.status = options.status;
  }

  const where = `WHERE ${conditions.join("\n        AND ")}`;

  // The page and its total are independent; one round trip, not two.
  const [invocations, countRows] = await Promise.all([
    queryAnalytics<InvocationFeedItem>({
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      query: `
      SELECT
        event_id AS eventId,
        timestamp,
        coalesce(event_name, 'unknown') AS toolName,
        JSONExtractString(intent_signals, 'intent') AS intent,
        JSONExtractString(intent_signals, 'source') AS intentSource,
        coalesce(platform, 'unknown') AS platform,
        coalesce(status, 'unknown') AS status,
        latency_ms AS latencyMs,
        error_category AS errorCategory,
        error_message AS errorMessage,
        coalesce(nullIf(user_id, ''), nullIf(subject_id, '')) AS userId,
        session_id AS sessionId,
        trace_id AS traceId,
        country_code AS countryCode,
        input_values AS inputValues,
        output_content AS outputContent,
        metadata
      FROM events
      ${where}
      -- event_id breaks timestamp ties so paging is deterministic (same
      -- reasoning as the intents feed).
      ORDER BY timestamp DESC, event_id DESC
      LIMIT 1 BY event_id
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
    `,
      params: { ...params, limit: pageSize, offset },
    }),
    queryAnalytics<{ total: number | string }>({
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      query: `
      SELECT count(DISTINCT event_id) AS total
      FROM events
      ${where}
    `,
      params,
    }),
  ]);

  return { invocations, total: Number(countRows[0]?.total ?? 0) };
}
