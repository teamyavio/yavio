import { ErrorCode, YavioError } from "@yavio/shared/errors";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

/**
 * Per-IP limits for requests that do not end up authenticated (#94).
 *
 * Authenticated requests are limited per API key (events route) and are not
 * charged here. Behind a reverse proxy every client used to share one IP
 * bucket, so scanner traffic (/.env, /.git/config) or simply the combined rate
 * of all customers got every SDK a 429.
 *
 * Two buckets per address:
 * - A request that cannot carry a credential is charged to the first one up
 *   front, so a flood of them is refused before any work.
 * - A request that may carry one (an Authorization header, or the events
 *   route, where a widget beacon carries its token in the body) is charged to
 *   the second one only if it fails to authenticate, and is refused up front
 *   only once that one is exhausted. This bounds a flood of bogus keys per
 *   address, while scanners — which carry no credential — can never throttle
 *   a client that authenticates. On the events route the header is checked
 *   before the body is parsed (#113), so a keyed client whose body fails to
 *   parse is authenticated by then and is not charged here.
 *
 * `request.ip` is the real client only when TRUST_PROXY names the proxy in
 * front of ingest; otherwise it is the socket peer.
 */
function mayCarryCredential(request: FastifyRequest): boolean {
  if (request.headers.authorization !== undefined) return true;
  return request.method === "POST" && request.url.split("?")[0] === "/v1/events";
}

function isHealthCheck(request: FastifyRequest): boolean {
  return request.url === "/health";
}

function tooMany(retryAfterMs: number): YavioError {
  const err = new YavioError(ErrorCode.INGEST.IP_RATE_LIMIT, "Too many requests from this IP", 429);
  // Attach retry-after as metadata so error handler can set header
  return Object.assign(err, { retryAfterMs });
}

const rateLimitHook: FastifyPluginAsync = async (app) => {
  app.decorateRequest("ipRateCharged", false);

  app.addHook("onRequest", async (request) => {
    if (!app.rateLimiter || isHealthCheck(request)) return;

    if (mayCarryCredential(request)) {
      const peek = app.rateLimiter.peekAuthFailure(request.ip);
      if (!peek.allowed) throw tooMany(peek.retryAfterMs);
      return;
    }

    request.ipRateCharged = true;
    const result = app.rateLimiter.consumeIp(request.ip);
    if (!result.allowed) throw tooMany(result.retryAfterMs);
  });

  app.addHook("onResponse", async (request) => {
    if (!app.rateLimiter || isHealthCheck(request)) return;
    if (request.ipRateCharged || request.authContext) return;
    // May have carried a credential but did not authenticate (invalid or
    // missing credential on the events route, unknown route with a header).
    app.rateLimiter.consumeAuthFailure(request.ip);
  });
};

export const rateLimitPlugin = fp(rateLimitHook, { name: "rate-limit" });
