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
      -- event_id breaks timestamp ties so paging is deterministic: without
      -- it, rows sharing a millisecond can shuffle between pages and appear
      -- twice or not at all.
      ORDER BY timestamp DESC, event_id DESC
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
 *
 * Coverage is split by how the SDK advertised `context` (intent_context,
 * #73). Call Coverage counts calls where the model was required to state an
 * intent, plus rows from SDKs before 0.4.0 (NULL), so history keeps the
 * denominator it had. Optional-context calls — widget-invoked tools, whose
 * own iframe calls cannot carry an intent, or `required: false` — get their
 * own share: who made such a call is not knowable, so it is not guessed.
 * `none` (per-tool intent: false, tool owns `context`) is in neither.
 */
export async function queryIntentKPIs(ctx: QueryContext): Promise<IntentKPIs> {
  const pf = platformFilter(ctx.platform);
  const hasIntent = "intent_signals != '{}' AND JSONExtractString(intent_signals, 'intent') != ''";
  const required = "ifNull(intent_context, 'required') = 'required'";
  const optional = "intent_context = 'optional'";

  const rows = await queryAnalytics<{
    captured: number;
    requiredCalls: number;
    requiredCaptured: number;
    optionalCalls: number;
    optionalCaptured: number;
    toolsWithIntents: number;
  }>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      SELECT
        countDistinctIf(event_id, ${hasIntent}) AS captured,
        countDistinctIf(event_id, ${required}) AS requiredCalls,
        countDistinctIf(event_id, ${required} AND ${hasIntent}) AS requiredCaptured,
        countDistinctIf(event_id, ${optional}) AS optionalCalls,
        countDistinctIf(event_id, ${optional} AND ${hasIntent}) AS optionalCaptured,
        uniqExactIf(event_name, ${hasIntent}) AS toolsWithIntents
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
  const requiredCalls = Number(r?.requiredCalls ?? 0);
  const optionalCalls = Number(r?.optionalCalls ?? 0);
  return {
    captured: Number(r?.captured ?? 0),
    // Null only when every call in the period had optional context: 0/0 is
    // not 0% coverage. With no calls at all it stays 0, as before.
    coverage:
      requiredCalls > 0
        ? Number(r?.requiredCaptured ?? 0) / requiredCalls
        : optionalCalls > 0
          ? null
          : 0,
    optionalCoverage: optionalCalls > 0 ? Number(r?.optionalCaptured ?? 0) / optionalCalls : null,
    toolsWithIntents: Number(r?.toolsWithIntents ?? 0),
  };
}
