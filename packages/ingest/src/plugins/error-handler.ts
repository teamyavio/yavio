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

    app.log.error(error, "Unhandled error");
    const fallback = new YavioError(ErrorCode.INGEST.INTERNAL_ERROR, "Internal server error", 500);
    return reply.status(500).send({
      error: fallback.toJSON(request.id),
    });
  });
};

export const errorHandlerPlugin = fp(errorHandler, { name: "error-handler" });
