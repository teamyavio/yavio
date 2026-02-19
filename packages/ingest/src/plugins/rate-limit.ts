import { ErrorCode, YavioError } from "@yavio/shared/errors";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

const rateLimitHook: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (request) => {
    if (!app.rateLimiter) return;

    // Skip rate limiting for health checks
    if (request.url === "/health") return;

    const ip = request.ip;
    const ipResult = app.rateLimiter.consumeIp(ip);
    if (!ipResult.allowed) {
      const err = new YavioError(
        ErrorCode.INGEST.IP_RATE_LIMIT,
        "Too many requests from this IP",
        429,
      );
      // Attach retry-after as metadata so error handler can set header
      throw Object.assign(err, { retryAfterMs: ipResult.retryAfterMs });
    }
  });
};

export const rateLimitPlugin = fp(rateLimitHook, { name: "rate-limit" });
