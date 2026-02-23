import { withAnalyticsAuth } from "@/lib/analytics/auth";
import { parseAnalyticsParams } from "@/lib/analytics/validation";
import { AnalyticsQueryError } from "@/lib/clickhouse/analytics-client";
import { queryToolLatencyHistogram, queryToolList } from "@/lib/queries/tools";
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

  if (!pagination.success) {
    return NextResponse.json(
      { error: "Invalid pagination", code: ErrorCode.DASHBOARD.INVALID_PAGINATION },
      { status: 400 },
    );
  }

  const { from, to, platform } = filters.data;
  const { page, pageSize, sort, order } = pagination.data;
  const tool = url.searchParams.get("tool");

  const queryCtx = {
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    from,
    to,
    platform,
  };

  try {
    if (tool) {
      const histogram = await queryToolLatencyHistogram(queryCtx, tool);
      return NextResponse.json({ histogram });
    }

    const result = await queryToolList(queryCtx, page, pageSize, sort, order);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AnalyticsQueryError) return err.toResponse();
    throw err;
  }
});
