import { withAnalyticsAuth } from "@/lib/analytics/auth";
import { parseAnalyticsParams } from "@/lib/analytics/validation";
import { AnalyticsQueryError } from "@/lib/clickhouse/analytics-client";
import {
  queryErrorCategoryBreakdown,
  queryErrorList,
  queryErrorRateTimeSeries,
} from "@/lib/queries/errors";
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
  const { filters, pagination } = parseAnalyticsParams(url.searchParams);

  if (!filters.success) {
    return NextResponse.json(
      { error: "Invalid filters", code: ErrorCode.DASHBOARD.VALIDATION_FAILED },
      { status: 400 },
    );
  }

  const { from, to, platform, granularity } = filters.data;
  const errorCategory = url.searchParams.get("errorCategory") ?? undefined;
  const page = pagination.success ? pagination.data.page : 1;
  const pageSize = pagination.success ? pagination.data.pageSize : 25;

  const queryCtx = {
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    from,
    to,
    platform,
  };

  try {
    const [timeSeries, categories, errorList] = await Promise.all([
      queryErrorRateTimeSeries(queryCtx, granularity),
      queryErrorCategoryBreakdown(queryCtx),
      queryErrorList(queryCtx, page, pageSize, errorCategory),
    ]);

    return NextResponse.json({ timeSeries, categories, ...errorList });
  } catch (err) {
    if (err instanceof AnalyticsQueryError) return err.toResponse();
    throw err;
  }
});
