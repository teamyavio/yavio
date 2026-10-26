import { ErrorCode, YavioError } from "@yavio/shared/errors";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RateLimiter, WidgetLimit } from "../lib/rate-limiter.js";
import type { AuthContext } from "../types.js";
import { isTextPlain } from "./auth.js";
import { apiKeyBucket, widgetBuckets, widgetUnits } from "./rate-limit.js";

/**
 * Rate-limit charges on the events route, in two steps.
 *
 * 1. Arrival (route onRequest, after the header authenticated the request
 *    and before its body is read): an API key is charged one event, a widget
 *    token its declared body size in units (Content-Length, or the body
 *    limit when there is none) on all of its widget buckets. A refusal is a
 *    429 and the body is never read.
 * 2. Settling (handler): the charge becomes the request's real one, events
 *    for an API key and widgetUnits(events, bytes read) for a widget token.
 *    More is charged when it is more (a refusal is a 429, the arrival charge
 *    stays: the body was read); a widget token gets back what it was charged
 *    above it. A request whose handler never runs (a body that fails to
 *    parse, or is over a limit) is settled to what was read instead
 *    (settleUnhandled).
 *
 * A beacon (token in the body) cannot be charged before it is read: its
 * whole charge is made when settling, and its address is charged on arrival
 * by the beacon bucket (plugins/rate-limit.ts).
 */

/** The largest bodies the route reads, by type (plugins/events.ts). */
export interface BodyLimits {
  json: number;
  text: number;
}

export interface ChargeOptions {
  /** `request.ip` is the client's address (TRUST_PROXY). */
  clientAddressTrusted?: boolean;
  limits: BodyLimits;
}

const WIDGET_LIMIT_MESSAGES: Record<WidgetLimit, string> = {
  token: "Widget token rate limit exceeded",
  address: "Widget rate limit exceeded for this address",
  project: "Widget rate limit exceeded for this project",
};

function apiKeyLimit(retryAfterMs: number): YavioError {
  const err = new YavioError(
    ErrorCode.INGEST.API_KEY_RATE_LIMIT,
    "API key rate limit exceeded",
    429,
  );
  return Object.assign(err, { retryAfterMs });
}

function widgetLimit(
  request: FastifyRequest,
  ctx: AuthContext,
  refusal: { retryAfterMs: number; limit: WidgetLimit; warn: boolean },
): YavioError {
  if (refusal.warn) {
    request.log.warn({ project_id: ctx.projectId }, "Widget rate limit for the project reached");
  }
  const err = new YavioError(
    ErrorCode.INGEST.WIDGET_TOKEN_RATE_LIMIT,
    WIDGET_LIMIT_MESSAGES[refusal.limit],
    429,
  );
  return Object.assign(err, { retryAfterMs: refusal.retryAfterMs });
}

function keysFor(request: FastifyRequest, ctx: AuthContext, opts: ChargeOptions) {
  return widgetBuckets(ctx, opts.clientAddressTrusted ? request.ip : undefined);
}

/**
 * The units a widget-token request is charged before its body is read: its
 * Content-Length in KiB, or the route's limit for its type when it declares
 * none (a chunked body, read up to that limit). A Content-Length over the
 * limit is refused 413 unread, so it costs one unit.
 */
export function reservationUnits(request: FastifyRequest, limits: BodyLimits): number {
  const limit = isTextPlain(request) ? limits.text : limits.json;
  const declared = Number(request.headers["content-length"]);
  if (request.headers["content-length"] === undefined || !Number.isFinite(declared)) {
    return widgetUnits(1, limit);
  }
  return declared > limit ? 1 : widgetUnits(1, declared);
}

/** Route onRequest hook, after authenticateHeader: the arrival charge. */
export function chargeOnArrival(app: FastifyInstance, opts: ChargeOptions) {
  return async (request: FastifyRequest): Promise<void> => {
    const limiter = app.rateLimiter;
    const ctx = request.authContext;
    if (!limiter || !ctx) return; // a beacon: charged when settling
    request.eventsCharged = true;

    if (ctx.source === "api_key") {
      const result = limiter.consumeApiKey(apiKeyBucket(ctx), 1);
      if (!result.allowed) throw apiKeyLimit(result.retryAfterMs);
      request.reservedUnits = 1;
      return;
    }

    const units = reservationUnits(request, opts.limits);
    const result = limiter.consumeWidget(keysFor(request, ctx, opts), units);
    if (!result.allowed) throw widgetLimit(request, ctx, result);
    request.reservedUnits = units;
  };
}

/**
 * In the handler: settle the arrival charge (if any) to the request's real
 * charge. `events` is the batch's event count, at most MAX_BATCH_EVENTS.
 */
export function settleCharge(
  limiter: RateLimiter,
  request: FastifyRequest,
  ctx: AuthContext,
  events: number,
  opts: ChargeOptions,
): void {
  request.eventsCharged = true;
  request.chargeSettled = true;
  const reserved = request.reservedUnits;

  if (ctx.source === "api_key") {
    const extra = events - reserved;
    if (extra > 0) {
      const result = limiter.consumeApiKey(apiKeyBucket(ctx), extra);
      if (!result.allowed) throw apiKeyLimit(result.retryAfterMs);
    }
    return;
  }

  const keys = keysFor(request, ctx, opts);
  const units = widgetUnits(events, request.bodyBytes);
  if (units < reserved) {
    limiter.refundWidget(keys, reserved - units);
    return;
  }
  if (units > reserved) {
    const result = limiter.consumeWidget(keys, units - reserved);
    if (!result.allowed) throw widgetLimit(request, ctx, result);
  }
}

/**
 * Route onResponse hook: a widget-token request charged on arrival whose
 * handler never ran is settled to the KiB its parser read (a body that
 * failed to parse, or nested too deep). When no parser ran (a body over a
 * limit, an unsupported type), how much was read is unknown and the arrival
 * charge stays. An API key keeps its one event, as before.
 */
export function settleUnhandled(app: FastifyInstance, opts: ChargeOptions) {
  return async (request: FastifyRequest): Promise<void> => {
    const limiter = app.rateLimiter;
    const ctx = request.authContext;
    if (!limiter || !ctx || request.chargeSettled || ctx.source !== "jwt") return;
    if (request.bodyBytes === 0) return;
    const units = widgetUnits(1, request.bodyBytes);
    if (request.reservedUnits > units) {
      limiter.refundWidget(keysFor(request, ctx, opts), request.reservedUnits - units);
    }
  };
}
