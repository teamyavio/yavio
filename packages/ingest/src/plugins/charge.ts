import { ErrorCode, YavioError } from "@yavio/shared/errors";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
    // What the socket has read so far, to tell later how much body came in
    // when no parser ran (an aborted or timed-out request, a body refused
    // before parsing). No count without a real socket.
    const bytesRead = request.raw.socket?.bytesRead;
    request.bytesAtArrival = typeof bytesRead === "number" ? bytesRead : -1;
  };
}

/**
 * Bytes the socket read since the arrival charge: the body received (it
 * misses the part read together with the headers). Undefined without a
 * socket count.
 */
function bytesSinceArrival(request: FastifyRequest): number | undefined {
  const now = request.raw.socket?.bytesRead;
  if (typeof now !== "number" || request.bytesAtArrival < 0) return undefined;
  return Math.max(0, now - request.bytesAtArrival);
}

/** Settle a widget token's arrival charge to `units`, giving back what was charged above it. */
function settleWidgetTo(
  limiter: RateLimiter,
  request: FastifyRequest,
  ctx: AuthContext,
  units: number,
  opts: ChargeOptions,
): void {
  request.chargeSettled = true;
  if (request.reservedUnits > units) {
    limiter.refundWidget(keysFor(request, ctx, opts), request.reservedUnits - units);
  }
}

/** A widget-token request charged on arrival that its handler did not settle. */
function unsettledWidget(app: FastifyInstance, request: FastifyRequest) {
  const limiter = app.rateLimiter;
  const ctx = request.authContext;
  if (!limiter || !ctx || ctx.source !== "jwt" || request.chargeSettled) return undefined;
  if (request.reservedUnits === 0) return undefined;
  return { limiter, ctx };
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
 * handler never ran is settled to what it made ingest read:
 * - a body its parser read (it failed to parse, or nested too deep): the KiB
 *   read;
 * - an unsupported type (415): one unit, nothing was read;
 * - otherwise (a body over a limit): the KiB the socket received since
 *   arrival, or, without a socket count, the arrival charge.
 * An API key keeps its one event, as before.
 */
export function settleUnhandled(app: FastifyInstance, opts: ChargeOptions) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const unsettled = unsettledWidget(app, request);
    if (!unsettled) return;
    let units: number;
    if (request.bodyBytes > 0) {
      units = widgetUnits(1, request.bodyBytes);
    } else if (reply.statusCode === 415) {
      units = 1;
    } else {
      const received = bytesSinceArrival(request);
      if (received === undefined) return;
      units = widgetUnits(1, received);
    }
    settleWidgetTo(unsettled.limiter, request, unsettled.ctx, units, opts);
  };
}

/**
 * Route onRequestAbort hook: a widget-token request whose client went away,
 * or whose body did not arrive within the request timeout (index.ts), gets
 * no response hook. It is settled to the KiB received: the bytes the socket
 * read since arrival, or its parser's count when that is more. Without
 * either, the arrival charge stays.
 */
export function settleAborted(app: FastifyInstance, opts: ChargeOptions) {
  return async (request: FastifyRequest): Promise<void> => {
    const unsettled = unsettledWidget(app, request);
    if (!unsettled) return;
    const received = bytesSinceArrival(request);
    if (received === undefined && request.bodyBytes === 0) return;
    const units = widgetUnits(1, Math.max(received ?? 0, request.bodyBytes));
    settleWidgetTo(unsettled.limiter, request, unsettled.ctx, units, opts);
  };
}
