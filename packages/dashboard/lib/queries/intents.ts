import { queryAnalytics } from "@/lib/clickhouse/analytics-client";
import type { IntentFeedItem, IntentKPIs } from "./types";

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

/** Project-wide paginated feed of captured intents, newest first. */
export async function queryIntentFeed(
  ctx: QueryContext,
  page: number,
  pageSize: number,
): Promise<{ intents: IntentFeedItem[]; total: number }> {
  const pf = platformFilter(ctx.platform);
  const offset = (page - 1) * pageSize;

  const baseWhere = `
      WHERE project_id = {projectId:String}
        AND event_type = 'tool_call'
        AND intent_signals != '{}'
        AND JSONExtractString(intent_signals, 'intent') != ''
        AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)}
        ${pf}`;

  const baseParams = {
    projectId: ctx.projectId,
    from: ctx.from,
    to: ctx.to,
    ...platformParams(ctx.platform),
  };

  const intents = await queryAnalytics<IntentFeedItem>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT
        event_id AS eventId,
        timestamp,
        JSONExtractString(intent_signals, 'intent') AS intent,
        JSONExtractString(intent_signals, 'source') AS source,
        coalesce(event_name, 'unknown') AS toolName,
        coalesce(platform, 'unknown') AS platform,
        coalesce(status, 'unknown') AS status,
        session_id AS sessionId
      FROM events
      ${baseWhere}
      ORDER BY timestamp DESC
      LIMIT 1 BY event_id
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
    `,
    params: { ...baseParams, limit: pageSize, offset },
  });

  const countRows = await queryAnalytics<{ total: number }>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT count(DISTINCT event_id) AS total
      FROM events
      ${baseWhere}
    `,
    params: baseParams,
  });

  return { intents, total: Number(countRows[0]?.total ?? 0) };
}

/**
 * Headline numbers for the intents page: how many intents were captured,
 * what share of tool calls carried one, and how many distinct tools they
 * cover in the selected period.
 */
export async function queryIntentKPIs(ctx: QueryContext): Promise<IntentKPIs> {
  const pf = platformFilter(ctx.platform);

  const rows = await queryAnalytics<{
    captured: number;
    totalCalls: number;
    toolsWithIntents: number;
  }>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT
        countDistinctIf(event_id, intent_signals != '{}' AND JSONExtractString(intent_signals, 'intent') != '') AS captured,
        count(DISTINCT event_id) AS totalCalls,
        uniqExactIf(event_name, intent_signals != '{}' AND JSONExtractString(intent_signals, 'intent') != '') AS toolsWithIntents
      FROM events
      WHERE project_id = {projectId:String}
        AND event_type = 'tool_call'
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

  const r = rows[0];
  const captured = Number(r?.captured ?? 0);
  const totalCalls = Number(r?.totalCalls ?? 0);
  return {
    captured,
    coverage: totalCalls > 0 ? captured / totalCalls : 0,
    toolsWithIntents: Number(r?.toolsWithIntents ?? 0),
  };
}
