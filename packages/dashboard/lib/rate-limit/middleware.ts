import { ErrorCode } from "@yavio/shared/error-codes";
import { NextResponse } from "next/server";
import type { RateLimitConfig } from "./rate-limiter";
import { RateLimiter } from "./rate-limiter";

type RouteHandler = (request: Request) => Promise<Response> | Response;

const limiters = new Map<string, RateLimiter>();

function getLimiter(name: string, config: RateLimitConfig): RateLimiter {
  let limiter = limiters.get(name);
  if (!limiter) {
    limiter = new RateLimiter(config);
    limiter.start();
    limiters.set(name, limiter);
  }
  return limiter;
}

export interface WithRateLimitOptions {
  name: string;
  config: RateLimitConfig;
  keyFrom: "ip" | "session";
}

export function withRateLimit(options: WithRateLimitOptions) {
  const limiter = getLimiter(options.name, options.config);

  return (handler: RouteHandler): RouteHandler => {
    return async (request: Request) => {
      const key =
        options.keyFrom === "ip"
          ? (request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown")
          : (request.headers.get("cookie")?.match(/session-token=([^;]+)/)?.[1] ?? "unknown");

      const result = limiter.consume(key);

      if (!result.allowed) {
        const retryAfter = Math.ceil(result.retryAfterMs / 1000);
        return NextResponse.json(
          { error: "Rate limit exceeded", code: ErrorCode.DASHBOARD.AUTH_ROUTE_RATE_LIMITED },
          {
            status: 429,
            headers: { "Retry-After": String(retryAfter) },
          },
        );
      }

      return handler(request);
    };
  };
}
