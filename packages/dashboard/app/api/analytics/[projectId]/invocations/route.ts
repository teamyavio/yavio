import { withAnalyticsAuth } from "@/lib/analytics/auth";
import { invocationFiltersSchema, parseAnalyticsParams } from "@/lib/analytics/validation";
import { AnalyticsQueryError } from "@/lib/clickhouse/analytics-client";
import { queryIntentKPIs } from "@/lib/queries/intents";
import { queryInvocationFeed } from "@/lib/queries/invocations";
import { queryIntentStatus } from "@/lib/queries/tool-detail";
import type { InvocationsResponse } from "@/lib/queries/types";
import { rateLimitConfigs } from "@/lib/rate-limit/config";
import { RateLimiter } from "@/lib/rate-limit/rate-limiter";
import { ErrorCode } from "@yavio/shared/error-codes";
import { NextResponse } from "next/server";

const limiter = new RateLimiter(rateLimitConfigs.analytics);
limiter.start();

/**
 * The merged invocation list (#44): every tool call in the range with its
 * intent inline, plus the intent KPIs and capture status the Intents page
 * used to carry.
 */
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
  const extra = invocationFiltersSchema.safeParse({
    tool: url.searchParams.get("tool") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    hasIntent: url.searchParams.get("hasIntent") ?? undefined,
  });

  if (!filters.success || !extra.success) {
    return NextResponse.json(
      { error: "Invalid filters", code: ErrorCode.DASHBOARD.VALIDATION_FAILED },
      { status: 400 },
    );
  }

  const { from, to, platform } = filters.data;
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
    const [feed, kpis, intentStatus] = await Promise.all([
      queryInvocationFeed(queryCtx, page, pageSize, extra.data),
      queryIntentKPIs(queryCtx),
      queryIntentStatus(queryCtx),
    ]);

    const body: InvocationsResponse = { ...feed, kpis, intentStatus };
    return NextResponse.json(body);
  } catch (err) {
    if (err instanceof AnalyticsQueryError) return err.toResponse();
    throw err;
  }
});
