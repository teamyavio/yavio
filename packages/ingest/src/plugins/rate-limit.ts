import { createHash } from "node:crypto";
import { ErrorCode, YavioError } from "@yavio/shared/errors";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { AuthContext } from "../types.js";

/**
 * Per-IP limits for requests that do not end up authenticated (#94).
 *
 * Authenticated requests are limited per API key or per widget token (events
 * route, by event count) and are not charged here. Behind a reverse proxy
 * every client used to share one IP bucket, so scanner traffic (/.env,
 * /.git/config) or simply the combined rate of all customers got every SDK a
 * 429.
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
 * - With TRUST_PROXY set, a header-less events request (a widget beacon,
 *   which is parsed before it can authenticate) is charged to the second one
 *   on arrival instead, and refunded once it authenticates
 *   (RateLimitPluginOptions).
 *
 * `request.ip` is the real client only when TRUST_PROXY names the proxy in
 * front of ingest; otherwise it is the socket peer.
 */
function mayCarryCredential(request: FastifyRequest): boolean {
  if (request.headers.authorization !== undefined) return true;
  return request.method === "POST" && request.url.split("?")[0] === "/v1/events";
}

/** An API key's bucket: per project, shared by every key of the project. */
export function apiKeyBucket(ctx: AuthContext): string {
  return `${ctx.projectId}:${ctx.workspaceId}`;
}

/**
 * A widget token's bucket: per project and the token's trace (`pid`, `tid`),
 * the scope every event of the token must match (WIDGET_TRACE_ID_MISMATCH).
 * Hashed, so the key has the same length whatever the claims hold.
 */
export function widgetTokenBucket(ctx: AuthContext): string {
  return createHash("sha256")
    .update(`${ctx.projectId}:${ctx.traceId ?? ""}`)
    .digest("base64url");
}

function isHealthCheck(request: FastifyRequest): boolean {
  return request.url === "/health";
}

function tooMany(retryAfterMs: number): YavioError {
  const err = new YavioError(ErrorCode.INGEST.IP_RATE_LIMIT, "Too many requests from this IP", 429);
  // Attach retry-after as metadata so error handler can set header
  return Object.assign(err, { retryAfterMs });
}

/** A request to the events route without an Authorization header: a widget beacon, or nothing. */
function isHeaderlessEvents(request: FastifyRequest): boolean {
  return (
    request.headers.authorization === undefined &&
    request.method === "POST" &&
    request.url.split("?")[0] === "/v1/events"
  );
}

export interface RateLimitPluginOptions {
  /**
   * Charge header-less events requests to the auth-failure bucket on
   * arrival, and refund the ones that authenticate (by a body token). Such a
   * request is parsed before it can authenticate, so the up-front charge
   * bounds how many of them per address are parsed at once. Needs a
   * `request.ip` that is the client: on only when TRUST_PROXY is set
   * (index.ts). Without it, every client behind a proxy shares the proxy's
   * address, and normal beacons would be refused together; header-less
   * requests are then charged only when they fail, after parsing (at most
   * BEACON_BODY_LIMIT each).
   */
  chargeHeaderlessOnArrival?: boolean;
}

const rateLimitHook: FastifyPluginAsync<RateLimitPluginOptions> = async (app, opts) => {
  app.decorateRequest("ipRateCharged", false);
  app.decorateRequest("eventsCharged", false);
  app.decorateRequest("authFailureCharged", false);

  app.addHook("onRequest", async (request) => {
    if (!app.rateLimiter || isHealthCheck(request)) return;

    if (opts.chargeHeaderlessOnArrival && isHeaderlessEvents(request)) {
      request.authFailureCharged = true;
      const result = app.rateLimiter.consumeAuthFailure(request.ip);
      if (!result.allowed) throw tooMany(result.retryAfterMs);
      return;
    }

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
    if (request.ipRateCharged) return;
    const ctx = request.authContext;
    if (ctx) {
      // A beacon charged on arrival that authenticated gets its token back.
      if (request.authFailureCharged) app.rateLimiter.refundAuthFailure(request.ip);
      // Authenticated, but the route handler never ran — the body failed to
      // parse (400) or was over the limit (413). Charged to the key's or the
      // widget token's bucket like any request of that credential, so a
      // flood of them is bounded there (#113); the handler charges per event
      // when it does run.
      if (!request.eventsCharged) {
        if (ctx.source === "api_key") {
          app.rateLimiter.consumeApiKey(apiKeyBucket(ctx), 1);
        } else {
          app.rateLimiter.consumeWidgetToken(widgetTokenBucket(ctx), 1);
        }
      }
      return;
    }
    // Charged on arrival already (or refused there).
    if (request.authFailureCharged) return;
    // May have carried a credential but did not authenticate (invalid or
    // missing credential on the events route, unknown route with a header).
    app.rateLimiter.consumeAuthFailure(request.ip);
  });
};

export const rateLimitPlugin = fp(rateLimitHook, { name: "rate-limit" });
