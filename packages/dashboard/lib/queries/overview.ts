import { fillTimeBuckets } from "@/lib/analytics/fill-buckets";
import { granularityToFunction } from "@/lib/analytics/format";
import type { Granularity } from "@/lib/analytics/validation";
import { AnalyticsQueryError, queryAnalytics } from "@/lib/clickhouse/analytics-client";
import type {
  KPIResult,
  LocationBreakdown,
  LocationCountry,
  LocationTotals,
  PlatformBreakdown,
  TimeSeriesPoint,
  ToolRanking,
} from "./types";
import { type TimeWindow, keyedEvents } from "./users";

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
  // ClickHouse serialises UInt64 aggregates as JSON strings; coerce so
  // consumers never do string arithmetic ("819" / "0" -> Infinity).
  const num = (v: unknown): number | undefined => {
    if (v === null || v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return [
    {
      label: "Invocations",
      value: num(r.invocations) ?? 0,
      previousValue: num(r.prev_invocations),
      format: "number",
    },
    {
      label: "Sessions",
      value: num(r.sessions) ?? 0,
      previousValue: num(r.prev_sessions),
      format: "number",
    },
    {
      label: "Error Rate",
      value: num(r.error_rate) ?? 0,
      previousValue: num(r.prev_error_rate),
      format: "percent",
    },
    {
      label: "Avg Latency",
      value: num(r.avg_latency) ?? 0,
      previousValue: num(r.prev_avg_latency),
      format: "latency",
    },
    {
      label: "Conversions",
      value: num(r.conversions) ?? 0,
      previousValue: num(r.prev_conversions),
      format: "number",
    },
    {
      label: "Revenue",
      value: num(r.revenue) ?? 0,
      previousValue: num(r.prev_revenue),
      format: "currency",
    },
  ];
}

export async function queryInvocationsTimeSeries(
  ctx: QueryContext,
  granularity: Granularity,
): Promise<TimeSeriesPoint[]> {
  const fn = granularityToFunction(granularity);
  const pf = platformFilter(ctx.platform);

  const rows = await queryAnalytics<TimeSeriesPoint>({
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
  return fillTimeBuckets(rows, ctx.from, ctx.to, granularity, (bucket) => ({ bucket, value: 0 }));
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

/**
 * Tool calls by country and region (#129), from raw events.
 *
 * Users are the Users page's key (keyedEvents, #89): user_id, else the
 * user_id stitched to the subject_id, else subject_id — never session_id —
 * stitched within the selected range like the windowed Users queries (#112).
 * Calls without a key count as calls, not as users (uniqExact skips NULL).
 *
 * One pass with GROUPING SETS, not two aggregations under a UNION ALL: the
 * keyed CTE is inlined per reference, so a UNION scanned events and built
 * the stitch join twice. The country set and the (country, region) set are
 * aggregated separately all the same — distinct users are not additive, so
 * a person seen in two regions of one country is one user of the country.
 * grouping(region_name) is 1 on the country rows (standard semantics,
 * force_grouping_standard_compatibility, on by default).
 *
 * NULL country_code / region become '' in SQL and null (Unknown) in the
 * result. Ingest stores a region only next to a valid country, so the
 * Unknown country has no regions; its region rows are not selected.
 */
export async function queryLocationBreakdown(ctx: QueryContext): Promise<LocationBreakdown> {
  const pf = platformFilter(ctx.platform);
  const window: TimeWindow = { from: "{from:DateTime64(3)}", to: "{to:DateTime64(3)}" };

  // Aliases differ from the columns on purpose: ClickHouse resolves an alias
  // before a column of the same name (see users.ts).
  const rows = await queryAnalytics<{
    is_country: number | string;
    country: string;
    region_name: string;
    tool_calls: number | string;
    users: number | string;
  }>({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    query: `
      WITH ${keyedEvents({ events: window, stitch: window })}
      SELECT grouping(region_name) AS is_country,
             ifNull(country_code, '') AS country,
             ifNull(region, '') AS region_name,
             count() AS tool_calls,
             uniqExact(user_key) AS users
      FROM keyed
      WHERE event_type = 'tool_call' ${pf}
      GROUP BY GROUPING SETS ((country), (country, region_name))
      HAVING is_country = 1 OR country != ''
    `,
    params: {
      projectId: ctx.projectId,
      from: ctx.from,
      to: ctx.to,
      ...platformParams(ctx.platform),
    },
  });

  const countries = new Map<string, LocationCountry>();
  let unknown: LocationTotals | null = null;
  for (const r of rows) {
    if (Number(r.is_country) !== 1) continue;
    const totals = { toolCalls: Number(r.tool_calls), users: Number(r.users) };
    if (r.country === "") unknown = totals;
    else countries.set(r.country, { countryCode: r.country, ...totals, regions: [] });
  }
  for (const r of rows) {
    if (Number(r.is_country) === 1) continue;
    countries.get(r.country)?.regions.push({
      region: r.region_name || null,
      toolCalls: Number(r.tool_calls),
      users: Number(r.users),
    });
  }

  // By tool calls, ties by name; within a country the Unknown region last.
  const list = [...countries.values()];
  for (const c of list) {
    c.regions.sort(
      (a, b) =>
        Number(a.region === null) - Number(b.region === null) ||
        b.toolCalls - a.toolCalls ||
        (a.region ?? "").localeCompare(b.region ?? ""),
    );
  }
  list.sort((a, b) => b.toolCalls - a.toolCalls || a.countryCode.localeCompare(b.countryCode));

  const locatedToolCalls = list.reduce((sum, c) => sum + c.toolCalls, 0);
  return {
    totalToolCalls: locatedToolCalls + (unknown?.toolCalls ?? 0),
    locatedToolCalls,
    countries: list,
    unknown,
  };
}

/**
 * queryLocationBreakdown, or null when ClickHouse fails it (queryAnalytics
 * has logged the error). The Overview and get_overview carry it next to the
 * KPIs: a failure here — a dashboard running ahead of migration 0020 on a
 * shared database, a timeout — must cost the Locations card, not the page.
 */
export async function queryLocationBreakdownOrNull(
  ctx: QueryContext,
): Promise<LocationBreakdown | null> {
  try {
    return await queryLocationBreakdown(ctx);
  } catch (err) {
    if (err instanceof AnalyticsQueryError) return null;
    throw err;
  }
}

/**
 * The breakdown cut to its largest countries and, within each, its largest
 * regions — for the MCP get_overview tool, whose answer lands in a model's
 * context. Every cut is marked (moreCountries, moreRegions), so the answer
 * never reads as complete when it is not; totals and Unknown are those of
 * the full breakdown.
 */
export function topLocations(breakdown: LocationBreakdown, maxCountries = 10, maxRegions = 5) {
  return {
    totalToolCalls: breakdown.totalToolCalls,
    locatedToolCalls: breakdown.locatedToolCalls,
    countries: breakdown.countries.slice(0, maxCountries).map((c) => ({
      ...c,
      regions: c.regions.slice(0, maxRegions),
      moreRegions: Math.max(c.regions.length - maxRegions, 0),
    })),
    moreCountries: Math.max(breakdown.countries.length - maxCountries, 0),
    unknown: breakdown.unknown,
  };
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
