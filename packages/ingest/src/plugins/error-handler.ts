import { ErrorCode, isYavioError } from "@yavio/shared/errors";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

const errorHandler: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (isYavioError(error)) {
      return reply.status(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.metadata ? { metadata: error.metadata } : {}),
        },
      });
    }

    app.log.error(error, "Unhandled error");
    return reply.status(500).send({
      error: {
        code: ErrorCode.INGEST.INTERNAL_ERROR,
        message: "Internal server error",
      },
    });
  });
};

export const errorHandlerPlugin = fp(errorHandler, { name: "error-handler" });
