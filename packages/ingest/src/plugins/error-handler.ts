import { ErrorCode, YavioError, isYavioError } from "@yavio/shared/errors";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

const errorHandler: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, request, reply) => {
    if (isYavioError(error)) {
      const extras = error as unknown as Record<string, unknown>;

      // Set Retry-After header for rate limit and backpressure errors
      if (
        (error.status === 429 || error.status === 503) &&
        typeof extras.retryAfterMs === "number"
      ) {
        reply.header("Retry-After", Math.ceil(extras.retryAfterMs / 1000).toString());
      }

      // Top-level sibling data (e.g. batch errors/accepted/rejected counts)
      const responseData =
        typeof extras.responseData === "object" && extras.responseData !== null
          ? (extras.responseData as Record<string, unknown>)
          : {};

      return reply.status(error.status).send({
        error: error.toJSON(request.id),
        ...responseData,
      });
    }

    // Fastify's own client errors — a body that is not JSON (400), one over
    // the body limit (413), an unsupported media type (415) — carry their
    // status; they are the client's fault and were answered 500 before (#113).
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      const code =
        status === 413
          ? ErrorCode.INGEST.BATCH_TOO_LARGE
          : ErrorCode.INGEST.SCHEMA_VALIDATION_FAILED;
      const message = error instanceof Error ? error.message : "Bad request";
      const clientError = new YavioError(code, message, status);
      return reply.status(status).send({ error: clientError.toJSON(request.id) });
    }

    app.log.error(error, "Unhandled error");
    const fallback = new YavioError(ErrorCode.INGEST.INTERNAL_ERROR, "Internal server error", 500);
    return reply.status(500).send({
      error: fallback.toJSON(request.id),
    });
  });
};

export const errorHandlerPlugin = fp(errorHandler, { name: "error-handler" });
