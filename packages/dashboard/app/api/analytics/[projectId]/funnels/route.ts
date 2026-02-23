import { withAnalyticsAuth } from "@/lib/analytics/auth";
import { parseAnalyticsParams } from "@/lib/analytics/validation";
import { AnalyticsQueryError } from "@/lib/clickhouse/analytics-client";
import {
  queryDropOffTraces,
  queryFunnelProgression,
  queryTraceTimeline,
} from "@/lib/queries/funnels";
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
  const queryCtx = { workspaceId: ctx.workspaceId, projectId: ctx.projectId, from, to };

  const traceId = url.searchParams.get("traceId");
  const dropOffStep = url.searchParams.get("dropOffStep");

  try {
    if (traceId) {
      const timeline = await queryTraceTimeline(queryCtx, traceId);
      return NextResponse.json({ timeline });
    }

    if (dropOffStep) {
      const traces = await queryDropOffTraces(queryCtx, Number(dropOffStep));
      return NextResponse.json({ traces });
    }

    const steps = await queryFunnelProgression(queryCtx);
    return NextResponse.json({ steps });
  } catch (err) {
    if (err instanceof AnalyticsQueryError) return err.toResponse();
    throw err;
  }
});
