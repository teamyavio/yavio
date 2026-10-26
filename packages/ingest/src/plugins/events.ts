import { ErrorCode, YavioError } from "@yavio/shared/errors";
import { MAX_BATCH_EVENTS } from "@yavio/shared/events";
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { enrichEvents } from "../lib/event-enricher.js";
import { normalizeEvents } from "../lib/event-normalizer.js";
import { enforceFieldLimits, isBatchTooLarge } from "../lib/field-limits.js";
import { MAX_BODY_NESTING, exceedsNesting } from "../lib/nesting.js";
import { EVENT_IDENTIFIER_FIELDS, stripPii } from "../lib/pii-stripper.js";
import type { WidgetLimit } from "../lib/rate-limiter.js";
import {
  MAX_REPORTED_ERRORS,
  type ValidationResult,
  validateBatch,
} from "../lib/schema-validator.js";
import { authenticateBodyToken, authenticateHeader } from "./auth.js";
import { apiKeyBucket, widgetBuckets, widgetUnits } from "./rate-limit.js";

export interface EventsPluginOptions {
  /**
   * `request.ip` is the client's address (TRUST_PROXY is set, index.ts):
   * widget-token requests are then also charged to their address's bucket.
   */
  clientAddressTrusted?: boolean;
}

const WIDGET_LIMIT_MESSAGES: Record<WidgetLimit, string> = {
  token: "Widget token rate limit exceeded",
  address: "Widget rate limit exceeded for this address",
  project: "Widget rate limit exceeded for this project",
};

function reportedErrors(errors: ValidationResult["errors"]): ValidationResult["errors"] {
  return errors.length > MAX_REPORTED_ERRORS ? errors.slice(0, MAX_REPORTED_ERRORS) : errors;
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
  request.bodyBytes = Buffer.byteLength(body);
  try {
    done(null, JSON.parse(body.toString()));
  } catch {
    done(new YavioError(ErrorCode.INGEST.SCHEMA_VALIDATION_FAILED, "Body is not valid JSON", 400));
  }
}

/**
 * The largest text/plain body the events route reads: sendBeacon's own
 * quota. Only a beacon may carry its token in the body, and only as
 * text/plain, so this is also the most a request that has not yet
 * authenticated can make ingest read. The React SDK splits beacons at
 * 60,000 bytes.
 */
export const BEACON_BODY_LIMIT = 64 * 1024;

/**
 * The largest JSON body the events route reads: the 500 KB batch limit
 * (field-limits.ts, checked on the parsed batch) plus room for formatting.
 * Longer bodies get 413 (YAVIO-2111) without being read in full.
 */
export const JSON_BODY_LIMIT = 600_000;

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
        request.bodyBytes = Buffer.byteLength(body);
        parseJson(request, body.toString(), done);
      },
    );
    registerEventsRoute(app, opts);
  });
};

function registerEventsRoute(app: FastifyInstance, opts: EventsPluginOptions): void {
  app.post(
    "/v1/events",
    {
      // The header before parsing (#113), the body token after it (#96).
      onRequest: [authenticateHeader],
      preHandler: [authenticateBodyToken],
      config: { rawBody: true },
    },
    async (request, reply) => {
      const ctx = request.authContext;
      if (!ctx) {
        throw new YavioError(ErrorCode.INGEST.MISSING_AUTH_HEADER, "Auth context missing", 401);
      }

      // 1. Rate limiting. API keys: by event count, per project. Widget
      //    tokens: in units (widgetUnits), per token (project and trace), per
      //    client address (with TRUST_PROXY) and per project, all or none.
      //    A batch over the cap is charged as a full batch, so it is answered
      //    with the cap's 400 below whenever the buckets can hold it, and
      //    with 429 only while one is short.
      if (app.rateLimiter) {
        const body = request.body as Record<string, unknown> | null;
        const eventCount = Array.isArray(body?.events)
          ? Math.min(body.events.length, MAX_BATCH_EVENTS)
          : 1;
        request.eventsCharged = true; // else the rate-limit plugin charges 1 on response
        if (ctx.source === "api_key") {
          const result = app.rateLimiter.consumeApiKey(apiKeyBucket(ctx), eventCount);
          if (!result.allowed) {
            const err = new YavioError(
              ErrorCode.INGEST.API_KEY_RATE_LIMIT,
              "API key rate limit exceeded",
              429,
            );
            throw Object.assign(err, { retryAfterMs: result.retryAfterMs });
          }
        } else {
          const result = app.rateLimiter.consumeWidget(
            widgetBuckets(ctx, opts.clientAddressTrusted ? request.ip : undefined),
            widgetUnits(eventCount, request.bodyBytes),
          );
          if (!result.allowed) {
            if (result.warn) {
              request.log.warn(
                { project_id: ctx.projectId },
                "Widget rate limit for the project reached",
              );
            }
            const err = new YavioError(
              ErrorCode.INGEST.WIDGET_TOKEN_RATE_LIMIT,
              WIDGET_LIMIT_MESSAGES[result.limit],
              429,
            );
            throw Object.assign(err, { retryAfterMs: result.retryAfterMs });
          }
        }
      }

      // 1b. Nesting depth: the size check below serializes the body again
      if (exceedsNesting(request.body, MAX_BODY_NESTING)) {
        const body = request.body as Record<string, unknown>;
        const issue = `Body nests deeper than ${MAX_BODY_NESTING} levels`;
        const err = new YavioError(ErrorCode.INGEST.SCHEMA_VALIDATION_FAILED, issue, 400);
        throw Object.assign(err, {
          responseData: {
            errors: [{ index: -1, issues: [issue] }],
            accepted: 0,
            rejected: Array.isArray(body.events) ? body.events.length : 1,
          },
        });
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
