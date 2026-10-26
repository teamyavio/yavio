import { createHash } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import { ErrorCode, YavioError } from "@yavio/shared/errors";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { WidgetBucketKeys } from "../lib/rate-limiter.js";
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

/**
 * A client address's bucket key: an IPv4 address as it is, an IPv6 address
 * by its /64 (one subscriber's network, which can hold many addresses). An
 * IPv4-mapped IPv6 address counts as its IPv4 address.
 */
export function addressBucket(ip: string): string {
  const address = ip.split("%")[0];
  if (isIPv4(address)) return address;
  if (!isIPv6(address)) return address;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped && isIPv4(mapped[1])) return mapped[1];
  return `${expandIPv6(address).slice(0, 4).join(":")}::/64`;
}

/** The eight hextets of a valid IPv6 address, lowercase, without leading zeros. */
function expandIPv6(address: string): string[] {
  const [head, tail] = address.includes("::") ? address.split("::") : [address, undefined];
  const toHextets = (part: string | undefined): string[] => {
    if (!part) return [];
    const groups = part.split(":");
    const last = groups[groups.length - 1];
    if (last.includes(".")) {
      // An embedded IPv4 address: its two hextets.
      const [a, b, c, d] = last.split(".").map(Number);
      groups.splice(-1, 1, ((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
    }
    return groups;
  };
  const front = toHextets(head);
  const back = toHextets(tail);
  const zeros = tail === undefined ? [] : Array(8 - front.length - back.length).fill("0");
  return [...front, ...zeros, ...back].map((h) => Number.parseInt(h, 16).toString(16));
}

/**
 * The buckets a widget-token request is charged to: its token's, its
 * client address's (only when `ip` is given, i.e. TRUST_PROXY is set), and
 * its project's widget ceiling, which is separate from the API-key bucket.
 */
export function widgetBuckets(ctx: AuthContext, ip: string | undefined): WidgetBucketKeys {
  return {
    token: widgetTokenBucket(ctx),
    ...(ip !== undefined ? { address: addressBucket(ip) } : {}),
    project: ctx.projectId,
  };
}

/**
 * A widget-token request costs one unit per event, or one per KiB of body
 * when that is more: what it makes ingest read and parse, not only what it
 * stores. A widget's batch (20 events, a few KB) and its beacon chunks (up
 * to 200 events in at most 60,000 bytes) are charged by their events.
 */
export const WIDGET_UNIT_BYTES = 1024;

export function widgetUnits(events: number, bodyBytes: number): number {
  return Math.max(events, Math.ceil(bodyBytes / WIDGET_UNIT_BYTES));
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
   * `request.ip` is the client's address: TRUST_PROXY is set (index.ts).
   * Then header-less events requests are charged to the auth-failure bucket
   * on arrival and refunded once they authenticate (by a body token): such a
   * request is parsed before it can authenticate, so the up-front charge
   * bounds how many of them per address are parsed at once. And a widget
   * request that never reached the handler is charged to its address's
   * widget bucket too. Without it, every client behind a proxy shares the
   * proxy's address, and normal beacons would be refused together;
   * header-less requests are then charged only when they fail, after
   * parsing (at most BEACON_BODY_LIMIT each).
   */
  clientAddressTrusted?: boolean;
}

const rateLimitHook: FastifyPluginAsync<RateLimitPluginOptions> = async (app, opts) => {
  app.decorateRequest("ipRateCharged", false);
  app.decorateRequest("eventsCharged", false);
  app.decorateRequest("authFailureCharged", false);
  app.decorateRequest("bodyBytes", 0);

  app.addHook("onRequest", async (request) => {
    if (!app.rateLimiter || isHealthCheck(request)) return;

    if (opts.clientAddressTrusted && isHeaderlessEvents(request)) {
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
          // In the handler's units: one event, or the KiB of body that was read.
          app.rateLimiter.consumeWidget(
            widgetBuckets(ctx, opts.clientAddressTrusted ? request.ip : undefined),
            widgetUnits(1, request.bodyBytes),
          );
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
