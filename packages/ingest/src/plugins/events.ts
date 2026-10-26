import { ErrorCode, YavioError } from "@yavio/shared/errors";
import { MAX_BATCH_EVENTS } from "@yavio/shared/events";
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { BEACON_BODY_LIMIT, JSON_BODY_LIMIT } from "../lib/body-limits.js";
import { enrichEvents } from "../lib/event-enricher.js";
import { normalizeEvents } from "../lib/event-normalizer.js";
import { enforceFieldLimits, isBatchTooLarge } from "../lib/field-limits.js";
import { MAX_BODY_NESTING, exceedsNestingText } from "../lib/nesting.js";
import { EVENT_IDENTIFIER_FIELDS, stripPii } from "../lib/pii-stripper.js";
import {
  MAX_REPORTED_ERRORS,
  type ValidationResult,
  validateBatch,
} from "../lib/schema-validator.js";
import { authenticateBodyToken, authenticateHeader } from "./auth.js";
import {
  type ChargeOptions,
  chargeOnArrival,
  settleAborted,
  settleCharge,
  settleUnhandled,
} from "./charge.js";

export interface EventsPluginOptions {
  /**
   * `request.ip` is the client's address (TRUST_PROXY is set, index.ts):
   * widget-token requests are then also charged to their address's bucket.
   */
  clientAddressTrusted?: boolean;
}

function reportedErrors(errors: ValidationResult["errors"]): ValidationResult["errors"] {
  return errors.length > MAX_REPORTED_ERRORS ? errors.slice(0, MAX_REPORTED_ERRORS) : errors;
}

/** A body nested deeper than MAX_BODY_NESTING: rejected whole, like the batch cap. */
function nestingError(): YavioError {
  const issue = `Body nests deeper than ${MAX_BODY_NESTING} levels`;
  const err = new YavioError(ErrorCode.INGEST.SCHEMA_VALIDATION_FAILED, issue, 400);
  return Object.assign(err, {
    responseData: { errors: [{ index: -1, issues: [issue] }], accepted: 0, rejected: 1 },
  });
}

/**
 * Before either parser runs JSON.parse: record the bytes read, and refuse a
 * body nested deeper than MAX_BODY_NESTING (one pass over the text).
 */
function readBody(request: FastifyRequest, body: string | Buffer): string | YavioError {
  const text = body.toString();
  request.bodyBytes = Buffer.byteLength(body);
  return exceedsNestingText(text, MAX_BODY_NESTING) ? nestingError() : text;
}

/**
 * Widget beacons send their JSON as text/plain: a CORS-safelisted type, so the
 * cross-origin beacon needs no preflight (#96). Parse it as JSON here.
 */
function parseTextAsJson(
  request: FastifyRequest,
  body: string | Buffer,
  done: (err: Error | null, body?: unknown) => void,
): void {
  const text = readBody(request, body);
  if (text instanceof YavioError) {
    done(text);
    return;
  }
  try {
    done(null, JSON.parse(text));
  } catch {
    done(new YavioError(ErrorCode.INGEST.SCHEMA_VALIDATION_FAILED, "Body is not valid JSON", 400));
  }
}

export { BEACON_BODY_LIMIT, JSON_BODY_LIMIT };

const eventsRoute: FastifyPluginAsync<EventsPluginOptions> = async (root, opts) => {
  // An encapsulated scope, so these parsers apply to this route only; every
  // other route keeps Fastify's defaults (text/plain stays a string, and the
  // global body limit). No route-level bodyLimit: it would override both.
  await root.register(async (app) => {
    app.removeContentTypeParser("text/plain");
    app.addContentTypeParser(
      "text/plain",
      { parseAs: "string", bodyLimit: BEACON_BODY_LIMIT },
      parseTextAsJson,
    );
    app.removeContentTypeParser("application/json");
    const parseJson = app.getDefaultJsonParser(
      app.initialConfig.onProtoPoisoning ?? "error",
      app.initialConfig.onConstructorPoisoning ?? "error",
    );
    app.addContentTypeParser(
      "application/json",
      { parseAs: "string", bodyLimit: JSON_BODY_LIMIT },
      (request, body, done) => {
        const text = readBody(request, body);
        if (text instanceof YavioError) done(text);
        else parseJson(request, text, done);
      },
    );
    registerEventsRoute(app, opts);
  });
};

function registerEventsRoute(app: FastifyInstance, opts: EventsPluginOptions): void {
  const charge: ChargeOptions = {
    clientAddressTrusted: opts.clientAddressTrusted,
    limits: { json: JSON_BODY_LIMIT, text: BEACON_BODY_LIMIT },
  };
  app.post(
    "/v1/events",
    {
      // The header, and the arrival charge, before parsing (#113); the body
      // token after it (#96).
      onRequest: [authenticateHeader, chargeOnArrival(app, charge)],
      preHandler: [authenticateBodyToken],
      onResponse: [settleUnhandled(app, charge)],
      onRequestAbort: [settleAborted(app, charge)],
      config: { rawBody: true },
    },
    async (request, reply) => {
      const ctx = request.authContext;
      if (!ctx) {
        throw new YavioError(ErrorCode.INGEST.MISSING_AUTH_HEADER, "Auth context missing", 401);
      }

      // 1. Rate limiting: settle the arrival charge (plugins/charge.ts) to
      //    the real one. API keys: by event count, per project. Widget
      //    tokens: in units (widgetUnits), per token, per client address
      //    (with TRUST_PROXY) and per project, all or none. A batch over the
      //    cap is charged as a full batch, so it is answered with the cap's
      //    400 below whenever the buckets can hold it, and with 429 only
      //    while one is short.
      if (app.rateLimiter) {
        const body = request.body as Record<string, unknown> | null;
        const eventCount = Array.isArray(body?.events)
          ? Math.min(body.events.length, MAX_BATCH_EVENTS)
          : 1;
        settleCharge(app.rateLimiter, request, ctx, eventCount, charge);
      }

      // 2. Batch size check
      const rawBody = JSON.stringify(request.body);
      if (isBatchTooLarge(rawBody)) {
        throw new YavioError(ErrorCode.INGEST.BATCH_TOO_LARGE, "Batch exceeds 500KB limit", 413);
      }

      // 3. Schema validation → partition valid/invalid
      const validation = validateBatch(request.body);

      // A batch over the cap is rejected whole, with the one cap error
      if (validation.overCap !== undefined) {
        const err = new YavioError(
          ErrorCode.INGEST.SCHEMA_VALIDATION_FAILED,
          `Batch exceeds ${MAX_BATCH_EVENTS} events`,
          400,
        );
        throw Object.assign(err, {
          responseData: {
            errors: validation.errors,
            accepted: 0,
            rejected: validation.overCap,
          },
        });
      }

      // If no valid events at all, throw 400 via centralized error handler
      if (validation.valid.length === 0) {
        const err = new YavioError(
          ErrorCode.INGEST.SCHEMA_VALIDATION_FAILED,
          "All events failed validation",
          400,
        );
        throw Object.assign(err, {
          responseData: {
            errors: reportedErrors(validation.errors),
            accepted: 0,
            rejected: validation.rejected,
          },
        });
      }

      // 3. Widget trace validation — JWT tid must match all event trace_ids
      if (ctx.source === "jwt" && ctx.traceId) {
        const mismatch = validation.valid.some((e) => e.trace_id !== ctx.traceId);
        if (mismatch) {
          throw new YavioError(
            ErrorCode.INGEST.WIDGET_TRACE_ID_MISMATCH,
            "All events must match the JWT trace_id",
            400,
          );
        }
      }

      // 4. Field size limits → per-event warnings/rejections
      const fieldResult = enforceFieldLimits(validation.valid);

      if (fieldResult.warnings.length > 0) {
        for (const w of fieldResult.warnings) {
          request.log.warn({ eventIndex: w.index, field: w.field }, w.warning);
        }
      }

      // 5. Normalise client-supplied fields (#90): clamp timestamps, NULL
      //    invalid country/currency/locale. Never rejects an event.
      const normalized = normalizeEvents(fieldResult.accepted);
      if (normalized.clampedTimestamps > 0 || normalized.invalidFields > 0) {
        request.log.warn(
          {
            timestamps_clamped: normalized.clampedTimestamps,
            invalid_fields_nulled: normalized.invalidFields,
          },
          "Normalised client-supplied event fields",
        );
      }

      // 5b. PII stripping — over content, not over ids (EVENT_IDENTIFIER_FIELDS)
      const { result: strippedEvents } = stripPii(normalized.events, {
        exemptEventKeys: EVENT_IDENTIFIER_FIELDS,
      });

      // 6. Event enrichment
      const enriched = enrichEvents(strippedEvents, ctx);

      // 7. Partition tool_discovery events for tool_registry
      const toolDiscoveryEvents = enriched.filter((e) => e.event_type === "tool_discovery");
      const regularEvents = enriched.filter((e) => e.event_type !== "tool_discovery");

      // 7a. Queue regular events to batch writer
      if (app.batchWriter && regularEvents.length > 0) {
        const backpressure = app.batchWriter.enqueue(regularEvents);
        if (backpressure) {
          const err = new YavioError(
            ErrorCode.INGEST.BACKPRESSURE_ACTIVE,
            "Server is under heavy load, please retry later",
            503,
          );
          throw Object.assign(err, { retryAfterMs: 1000 });
        }
      }

      // 7b. Queue tool_discovery events to tool registry writer
      if (app.toolRegistryWriter && toolDiscoveryEvents.length > 0) {
        const registryBackpressure = app.toolRegistryWriter.enqueue(toolDiscoveryEvents);
        if (registryBackpressure) {
          request.log.warn("Tool registry writer backpressure active, events may be dropped");
        }
      }

      // 8. Build response
      const totalRejected = validation.rejected + fieldResult.rejected.length;
      const totalAccepted = enriched.length;

      // Combine all errors
      const allErrors = [
        ...validation.errors,
        ...fieldResult.rejected.map((r) => ({
          index: r.index,
          issues: [r.reason],
        })),
      ];

      if (totalAccepted === 0) {
        // 400: All rejected (schema + field limits combined)
        const err = new YavioError(
          ErrorCode.INGEST.SCHEMA_VALIDATION_FAILED,
          "All events failed validation",
          400,
        );
        throw Object.assign(err, {
          responseData: {
            errors: reportedErrors(allErrors),
            accepted: 0,
            rejected: totalRejected,
          },
        });
      }

      if (totalRejected === 0) {
        // 200: All accepted
        return reply.status(200).send({
          accepted: totalAccepted,
          rejected: 0,
          warnings: fieldResult.warnings.length > 0 ? fieldResult.warnings : undefined,
          requestId: request.id,
        });
      }

      // 207: Partial acceptance
      return reply.status(207).send({
        accepted: totalAccepted,
        rejected: totalRejected,
        errors: reportedErrors(allErrors),
        warnings: fieldResult.warnings.length > 0 ? fieldResult.warnings : undefined,
        requestId: request.id,
      });
    },
  );
}

export const eventsPlugin = fp(eventsRoute, { name: "events" });
