import { withAnalyticsAuth } from "@/lib/analytics/auth";
import { parseAnalyticsParams } from "@/lib/analytics/validation";
import { AnalyticsQueryError } from "@/lib/clickhouse/analytics-client";
import { queryRetentionCohorts } from "@/lib/queries/users";
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
  const { filters } = parseAnalyticsParams(url.searchParams);

  if (!filters.success) {
    return NextResponse.json(
      { error: "Invalid filters", code: ErrorCode.DASHBOARD.VALIDATION_FAILED },
      { status: 400 },
    );
  }

  const { from, to } = filters.data;
  const validPeriods = ["day", "week", "month"] as const;
  type Period = (typeof validPeriods)[number];
  const rawPeriod = url.searchParams.get("period") ?? "week";
  const period: Period = (validPeriods as readonly string[]).includes(rawPeriod)
    ? (rawPeriod as Period)
    : "week";

  try {
    const cohorts = await queryRetentionCohorts(
      { workspaceId: ctx.workspaceId, projectId: ctx.projectId, from, to },
      period,
    );
    return NextResponse.json({ cohorts });
  } catch (err) {
    if (err instanceof AnalyticsQueryError) return err.toResponse();
    throw err;
  }
});
