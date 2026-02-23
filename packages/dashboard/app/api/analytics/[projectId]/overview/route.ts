import { withAnalyticsAuth } from "@/lib/analytics/auth";
import { parseAnalyticsParams } from "@/lib/analytics/validation";
import { AnalyticsQueryError } from "@/lib/clickhouse/analytics-client";
import {
  queryInvocationsTimeSeries,
  queryOverviewKPIs,
  queryPlatformBreakdown,
  queryTopTools,
} from "@/lib/queries/overview";
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
      { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } },
    );
  }

  const url = new URL(request.url);
  const { filters, pagination } = parseAnalyticsParams(url.searchParams);

  if (!filters.success) {
    return NextResponse.json(
      {
        error: "Invalid filters",
        code: ErrorCode.DASHBOARD.VALIDATION_FAILED,
        details: filters.error.flatten(),
      },
      { status: 400 },
    );
  }

  const { from, to, platform, granularity } = filters.data;
  const queryCtx = {
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    from,
    to,
    platform,
  };

  try {
    const [kpis, timeSeries, platforms, topTools] = await Promise.all([
      queryOverviewKPIs(queryCtx),
      queryInvocationsTimeSeries(queryCtx, granularity),
      queryPlatformBreakdown(queryCtx),
      queryTopTools(queryCtx),
    ]);

    return NextResponse.json({ kpis, timeSeries, platforms, topTools });
  } catch (err) {
    if (err instanceof AnalyticsQueryError) {
      return err.toResponse();
    }
    throw err;
  }
});
