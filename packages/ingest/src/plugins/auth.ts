import { ErrorCode, YavioError } from "@yavio/shared/errors";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { MAX_SESSION_ID_LENGTH, MAX_TRACE_ID_LENGTH } from "../lib/field-limits.js";
import { jwtVerify } from "../lib/jwt.js";

const API_KEY_PREFIX = "yav_";
const JWT_PREFIX = "eyJ";

/** A non-empty string of at most `max` characters: a widget token's `tid` and `sid`. */
export function isBoundedId(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

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
  await authenticateToken(request, bearerToken(header));
}

/**
 * The events route's onRequest hook: the Authorization header, when there is
 * one, is checked BEFORE the body is parsed (#113). A request whose body then
 * fails to parse (400, 413) is already authenticated, so the rate limiter does
 * not count it as a failed credential — it used to, and a keyed client with a
 * serialisation bug locked its own address out of the events route. A bad key
 * is refused before any parsing work, too. Without a header, a text/plain
 * request (a widget beacon) is parsed, up to BEACON_BODY_LIMIT, and goes on to
 * authenticateBodyToken; any other type is refused here, unread.
 */
export async function authenticateHeader(request: FastifyRequest): Promise<void> {
  if (request.headers.authorization) {
    await authenticate(request);
    return;
  }
  // Without a header, only a widget beacon can authenticate, by the token in
  // its text/plain body. Any other request without one is refused before its
  // body is read.
  if (!isTextPlain(request)) throw missingCredential();
}

/** Whether the request's body is text/plain: the only type a body token is read from. */
export function isTextPlain(request: FastifyRequest): boolean {
  const type = request.headers["content-type"];
  return typeof type === "string" && type.split(";")[0].trim().toLowerCase() === "text/plain";
}

function missingCredential(): YavioError {
  return new YavioError(
    ErrorCode.INGEST.MISSING_AUTH_HEADER,
    "Authorization header (or, for widget beacons, a token in the body) is required",
    401,
  );
}

/**
 * The events route's preHandler, for widget beacons: a widget JWT in the body
 * (#96). navigator.sendBeacon cannot set headers, so the widget sends
 * `{ token, events, ... }`. The header is authenticateHeader's job, before
 * parsing; a request it authenticated passes through here untouched except
 * that a token in its body is still removed.
 *
 * - Only a widget JWT is accepted from the body, and only from a text/plain
 *   body (authenticateHeader refuses other types without a header); API keys
 *   belong to servers, which can set headers.
 * - The token is removed from the body once read, so nothing downstream can
 *   store or log it.
 * - A beacon whose body fails to parse never gets here: it carried no header,
 *   so the rate limiter counts it as a request without a credential.
 */
export async function authenticateBodyToken(request: FastifyRequest): Promise<void> {
  const body = request.body as Record<string, unknown> | null | undefined;
  const bodyToken = body && typeof body === "object" ? body.token : undefined;
  if (body && typeof body === "object" && "token" in body) {
    Reflect.deleteProperty(body, "token");
  }

  if (request.authContext) return;
  if (typeof bodyToken !== "string" || bodyToken === "" || !isTextPlain(request)) {
    throw missingCredential();
  }
  if (!bodyToken.startsWith(JWT_PREFIX)) {
    throw new YavioError(
      ErrorCode.INGEST.MALFORMED_BEARER_TOKEN,
      "Only a widget token is accepted in the body; send API keys in the Authorization header",
      401,
    );
  }
  resolveJwt(request, bodyToken);
}

function bearerToken(header: string): string {
  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    throw new YavioError(
      ErrorCode.INGEST.MALFORMED_BEARER_TOKEN,
      "Authorization header must be: Bearer <token>",
      401,
    );
  }
  return parts[1];
}

async function authenticateToken(request: FastifyRequest, token: string): Promise<void> {
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

  // A token minted before the mint bounded its ids stays valid for its 15
  // minutes: its claims are held to the same bounds here.
  if (
    !payload ||
    !isBoundedId(payload.tid, MAX_TRACE_ID_LENGTH) ||
    !isBoundedId(payload.sid, MAX_SESSION_ID_LENGTH)
  ) {
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
