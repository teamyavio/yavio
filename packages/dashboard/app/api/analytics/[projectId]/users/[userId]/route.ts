import { withAnalyticsAuth } from "@/lib/analytics/auth";
import { parseAnalyticsParams } from "@/lib/analytics/validation";
import { AnalyticsQueryError } from "@/lib/clickhouse/analytics-client";
import { queryUserDetail } from "@/lib/queries/users";
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
  const userId = url.pathname.split("/").pop();
  const { filters } = parseAnalyticsParams(url.searchParams);

  if (!filters.success) {
    return NextResponse.json(
      { error: "Invalid filters", code: ErrorCode.DASHBOARD.VALIDATION_FAILED },
      { status: 400 },
    );
  }

  if (!userId) {
    return NextResponse.json({ error: "User ID required" }, { status: 400 });
  }

  const { from, to } = filters.data;

  try {
    const events = await queryUserDetail(
      { workspaceId: ctx.workspaceId, projectId: ctx.projectId, from, to },
      userId,
    );
    return NextResponse.json({ events });
  } catch (err) {
    if (err instanceof AnalyticsQueryError) return err.toResponse();
    throw err;
  }
});
