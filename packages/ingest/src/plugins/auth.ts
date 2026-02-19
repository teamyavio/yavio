import { ErrorCode, YavioError } from "@yavio/shared/errors";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { jwtVerify } from "../lib/jwt.js";

const API_KEY_PREFIX = "yav_";
const JWT_PREFIX = "eyJ";

/**
 * Auth preHandler that can be added to individual routes.
 * Reads `Authorization: Bearer <token>`, determines token type,
 * and decorates `request.authContext`.
 */
export async function authenticate(request: FastifyRequest): Promise<void> {
  const header = request.headers.authorization;
  if (!header) {
    throw new YavioError(
      ErrorCode.INGEST.MISSING_AUTH_HEADER,
      "Authorization header is required",
      401,
    );
  }

  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    throw new YavioError(
      ErrorCode.INGEST.MALFORMED_BEARER_TOKEN,
      "Authorization header must be: Bearer <token>",
      401,
    );
  }

  const token = parts[1];

  if (token.startsWith(API_KEY_PREFIX)) {
    await resolveApiKey(request, token);
  } else if (token.startsWith(JWT_PREFIX)) {
    resolveJwt(request, token);
  } else {
    throw new YavioError(ErrorCode.INGEST.MALFORMED_BEARER_TOKEN, "Unrecognised token format", 401);
  }
}

async function resolveApiKey(request: FastifyRequest, token: string): Promise<void> {
  const resolved = await request.server.apiKeyResolver.resolve(token);

  if (!resolved) {
    throw new YavioError(ErrorCode.INGEST.INVALID_API_KEY, "Invalid or revoked API key", 401);
  }

  request.authContext = {
    projectId: resolved.projectId,
    workspaceId: resolved.workspaceId,
    source: "api_key",
  };
}

function resolveJwt(request: FastifyRequest, token: string): void {
  const jwtSecret = request.server.jwtSecret;
  const payload = jwtVerify(token, jwtSecret);

  if (!payload) {
    throw new YavioError(ErrorCode.INGEST.INVALID_WIDGET_JWT, "Invalid or expired widget JWT", 401);
  }

  request.authContext = {
    projectId: payload.pid,
    workspaceId: payload.wid,
    traceId: payload.tid,
    sessionId: payload.sid,
    source: "jwt",
  };
}

/**
 * Plugin that registers the `authContext` request decorator.
 * Does NOT add a global hook — routes opt in via `{ preHandler: [authenticate] }`.
 */
const authSetup: FastifyPluginAsync = async (app) => {
  app.decorateRequest("authContext", undefined);
};

export const authPlugin = fp(authSetup, { name: "auth" });
