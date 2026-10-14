import { ErrorCode, YavioError } from "@yavio/shared/errors";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { enrichEvents } from "../lib/event-enricher.js";
import { normalizeEvents } from "../lib/event-normalizer.js";
import { enforceFieldLimits, isBatchTooLarge } from "../lib/field-limits.js";
import { EVENT_IDENTIFIER_FIELDS, stripPii } from "../lib/pii-stripper.js";
import { validateBatch } from "../lib/schema-validator.js";
import { authenticateBodyToken, authenticateHeader } from "./auth.js";

/**
 * Widget beacons send their JSON as text/plain: a CORS-safelisted type, so the
 * cross-origin beacon needs no preflight (#96). Parse it as JSON here.
 */
function parseTextAsJson(
  _request: unknown,
  body: string | Buffer,
  done: (err: Error | null, body?: unknown) => void,
): void {
  try {
    done(null, JSON.parse(body.toString()));
  } catch {
    done(new YavioError(ErrorCode.INGEST.SCHEMA_VALIDATION_FAILED, "Body is not valid JSON", 400));
  }
}

const eventsRoute: FastifyPluginAsync = async (root) => {
  // An encapsulated scope, so the text/plain parser applies to this route only;
  // every other route keeps Fastify's default (text/plain stays a string).
  await root.register(async (app) => {
    app.removeContentTypeParser("text/plain");
    app.addContentTypeParser("text/plain", { parseAs: "string" }, parseTextAsJson);
    registerEventsRoute(app);
  });
};

function registerEventsRoute(app: FastifyInstance): void {
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

      // 1. Per-API-key rate limiting (event count)
      if (app.rateLimiter && ctx.source === "api_key") {
        const body = request.body as Record<string, unknown> | null;
        const eventCount = Array.isArray(body?.events) ? body.events.length : 1;
        const keyId = `${ctx.projectId}:${ctx.workspaceId}`;
        request.apiKeyCharged = true; // else the rate-limit plugin charges 1 on response
        const result = app.rateLimiter.consumeApiKey(keyId, eventCount);
        if (!result.allowed) {
          const err = new YavioError(
            ErrorCode.INGEST.API_KEY_RATE_LIMIT,
            "API key rate limit exceeded",
            429,
          );
          throw Object.assign(err, { retryAfterMs: result.retryAfterMs });
        }
      }

      // 2. Batch size check
      const rawBody = JSON.stringify(request.body);
      if (isBatchTooLarge(rawBody)) {
        throw new YavioError(ErrorCode.INGEST.BATCH_TOO_LARGE, "Batch exceeds 500KB limit", 413);
      }

      // 3. Schema validation → partition valid/invalid
      const validation = validateBatch(request.body);

      // If no valid events at all, throw 400 via centralized error handler
      if (validation.valid.length === 0) {
        const err = new YavioError(
          ErrorCode.INGEST.SCHEMA_VALIDATION_FAILED,
          "All events failed validation",
          400,
        );
        throw Object.assign(err, {
          responseData: {
            errors: validation.errors,
            accepted: 0,
            rejected: validation.errors.length,
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
      const totalRejected = validation.errors.length + fieldResult.rejected.length;
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
            errors: allErrors,
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
        errors: allErrors,
        warnings: fieldResult.warnings.length > 0 ? fieldResult.warnings : undefined,
        requestId: request.id,
      });
    },
  );
}

export const eventsPlugin = fp(eventsRoute, { name: "events" });
