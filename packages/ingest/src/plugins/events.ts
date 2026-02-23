import { ErrorCode, YavioError } from "@yavio/shared/errors";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { enrichEvents } from "../lib/event-enricher.js";
import { enforceFieldLimits, isBatchTooLarge } from "../lib/field-limits.js";
import { stripPii } from "../lib/pii-stripper.js";
import { validateBatch } from "../lib/schema-validator.js";
import { authenticate } from "./auth.js";

const eventsRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/v1/events",
    {
      preHandler: [authenticate],
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

      // 5. PII stripping
      const { result: strippedEvents } = stripPii(fieldResult.accepted);

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
};

export const eventsPlugin = fp(eventsRoute, { name: "events" });
