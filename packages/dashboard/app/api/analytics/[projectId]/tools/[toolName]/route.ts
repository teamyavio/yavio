import { withAnalyticsAuth } from "@/lib/analytics/auth";
import { parseAnalyticsParams } from "@/lib/analytics/validation";
import { AnalyticsQueryError } from "@/lib/clickhouse/analytics-client";
import {
  queryToolCallVolume,
  queryToolDetailKPIs,
  queryToolErrorCategories,
  queryToolLatencyPercentiles,
  queryToolPlatformBreakdown,
  queryToolRecentInvocations,
  queryToolRegistryEntry,
} from "@/lib/queries/tool-detail";
import { queryToolErrorRateTimeSeries, queryToolLatencyHistogram } from "@/lib/queries/tools";
import { rateLimitConfigs } from "@/lib/rate-limit/config";
import { RateLimiter } from "@/lib/rate-limit/rate-limiter";
import { ErrorCode } from "@yavio/shared/error-codes";
import { NextResponse } from "next/server";

const limiter = new RateLimiter(rateLimitConfigs.analytics);
limiter.start();

export const GET = withAnalyticsAuth("viewer")(async (request, ctx) => {
  const limit = limiter.consume(ctx.userId);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Rate limited", code: ErrorCode.DASHBOARD.ANALYTICS_QUERY_RATE_LIMITED },
      { status: 429 },
    );
  }

  const url = new URL(request.url);
  const segments = url.pathname.split("/");
  const toolName = decodeURIComponent(segments[segments.length - 1] as string);
  const { filters, pagination } = parseAnalyticsParams(url.searchParams);

  if (!filters.success) {
    return NextResponse.json(
      { error: "Invalid filters", code: ErrorCode.DASHBOARD.VALIDATION_FAILED },
      { status: 400 },
    );
  }

  if (!pagination.success) {
    return NextResponse.json(
      { error: "Invalid pagination", code: ErrorCode.DASHBOARD.INVALID_PAGINATION },
      { status: 400 },
    );
  }

  if (!toolName) {
    return NextResponse.json({ error: "Tool name required" }, { status: 400 });
  }

  const { from, to, platform, granularity } = filters.data;
  const { page, pageSize } = pagination.data;

  const queryCtx = {
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    from,
    to,
    platform,
  };

  try {
    const [
      kpis,
      callVolume,
      histogram,
      latencyPercentiles,
      errorRateTimeSeries,
      errorCategories,
      platforms,
      invocationsResult,
      registry,
    ] = await Promise.all([
      queryToolDetailKPIs(queryCtx, toolName),
      queryToolCallVolume(queryCtx, toolName, granularity),
      queryToolLatencyHistogram(queryCtx, toolName),
      queryToolLatencyPercentiles(queryCtx, toolName, granularity),
      queryToolErrorRateTimeSeries(queryCtx, toolName, granularity),
      queryToolErrorCategories(queryCtx, toolName),
      queryToolPlatformBreakdown(queryCtx, toolName),
      queryToolRecentInvocations(queryCtx, toolName, page, pageSize),
      queryToolRegistryEntry(queryCtx, toolName),
    ]);

    return NextResponse.json({
      registry,
      kpis,
      callVolume,
      histogram,
      latencyPercentiles,
      errorRateTimeSeries,
      errorCategories,
      platforms,
      invocations: invocationsResult.invocations,
      invocationsTotal: invocationsResult.total,
    });
  } catch (err) {
    if (err instanceof AnalyticsQueryError) return err.toResponse();
    throw err;
  }
});
