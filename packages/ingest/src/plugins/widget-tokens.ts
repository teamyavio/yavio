import { ErrorCode, YavioError } from "@yavio/shared/errors";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { jwtSign } from "../lib/jwt.js";
import { authenticate } from "./auth.js";

const JWT_EXPIRY_SECONDS = 15 * 60; // 15 minutes

interface WidgetTokenBody {
  traceId?: string;
  sessionId?: string;
}

const widgetTokensRoute: FastifyPluginAsync<{ jwtSecret: string }> = async (app, opts) => {
  app.post<{ Body: WidgetTokenBody }>(
    "/v1/widget-tokens",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const ctx = request.authContext;
      if (!ctx || ctx.source !== "api_key") {
        throw new YavioError(
          ErrorCode.INGEST.WIDGET_TOKEN_UNAUTHORIZED,
          "Widget tokens can only be minted with an API key",
          401,
        );
      }

      const body = request.body as WidgetTokenBody | null;
      if (!body?.traceId) {
        throw new YavioError(ErrorCode.INGEST.MISSING_TRACE_ID, "traceId is required", 400);
      }
      if (!body.sessionId) {
        throw new YavioError(ErrorCode.INGEST.MISSING_SESSION_ID, "sessionId is required", 400);
      }

      const now = Math.floor(Date.now() / 1000);
      const exp = now + JWT_EXPIRY_SECONDS;

      const token = jwtSign(
        {
          pid: ctx.projectId,
          wid: ctx.workspaceId,
          tid: body.traceId,
          sid: body.sessionId,
          iat: now,
          exp,
        },
        opts.jwtSecret,
      );

      return reply.status(200).send({
        token,
        expiresAt: new Date(exp * 1000).toISOString(),
      });
    },
  );
};

export const widgetTokensPlugin = fp(widgetTokensRoute, { name: "widget-tokens" });
