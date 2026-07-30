import { resolveClient } from "@/lib/oauth/clients";
import { mcpResourceUri } from "@/lib/oauth/constants";
import { OAuthError } from "@/lib/oauth/errors";
import {
  consumeAuthorizationCode,
  issueTokens,
  pruneExpired,
  rotateRefreshToken,
} from "@/lib/oauth/store";
import { hashToken, verifyPkceS256 } from "@/lib/oauth/tokens";
import { rateLimitConfigs } from "@/lib/rate-limit/config";
import { RateLimiter } from "@/lib/rate-limit/rate-limiter";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const RESPONSE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  ...CORS_HEADERS,
};

async function parseBody(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type") ?? "";
  const text = await request.text();
  if (contentType.includes("application/json")) {
    // Lenient fallback; the spec (and Claude) use form encoding.
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(json)) {
        if (typeof value === "string") params.set(key, value);
      }
      return params;
    } catch {
      throw new OAuthError("invalid_request", "request body is not valid JSON", 400);
    }
  }
  return new URLSearchParams(text);
}

function require(params: URLSearchParams, name: string): string {
  const value = params.get(name);
  if (!value) {
    throw new OAuthError("invalid_request", `missing ${name}`, 400);
  }
  return value;
}

/** RFC 8707: when a resource is named it must be OUR canonical MCP URI. */
function checkResource(params: URLSearchParams): void {
  const resource = params.get("resource");
  if (resource !== null && resource !== mcpResourceUri()) {
    throw new OAuthError("invalid_target", "resource does not identify this MCP server", 400);
  }
}

async function handleAuthorizationCode(params: URLSearchParams): Promise<Response> {
  const clientId = require(params, "client_id");
  const code = require(params, "code");
  const codeVerifier = require(params, "code_verifier");
  const redirectUri = require(params, "redirect_uri");
  checkResource(params);

  // Unknown DCR ids answer 401 invalid_client — Claude's re-register signal.
  await resolveClient(clientId);

  const grant = await consumeAuthorizationCode(code);
  if (grant.clientId !== clientId) {
    throw new OAuthError(
      "invalid_grant",
      "authorization code was issued to a different client",
      400,
    );
  }
  if (grant.redirectUri !== redirectUri) {
    throw new OAuthError(
      "invalid_grant",
      "redirect_uri does not match the authorization request",
      400,
    );
  }
  if (!verifyPkceS256(codeVerifier, grant.codeChallenge)) {
    throw new OAuthError("invalid_grant", "PKCE verification failed", 400);
  }

  const scopes = grant.scope.split(" ");
  const issued = await issueTokens({
    clientId,
    userId: grant.userId,
    workspaceId: grant.workspaceId,
    scope: grant.scope,
    audience: mcpResourceUri(),
    includeRefreshToken: scopes.includes("offline_access"),
  });

  return Response.json(
    {
      access_token: issued.accessToken,
      token_type: "Bearer",
      expires_in: issued.accessTokenExpiresInSeconds,
      refresh_token: issued.refreshToken ?? undefined,
      scope: grant.scope,
    },
    { headers: RESPONSE_HEADERS },
  );
}

async function handleRefreshToken(params: URLSearchParams): Promise<Response> {
  const clientId = require(params, "client_id");
  const refreshToken = require(params, "refresh_token");
  // Codex is known to omit `resource` on refresh — never require it here; if
  // present it must still point at us. The audience recorded at issuance is
  // what the new access token inherits either way.
  checkResource(params);

  // No resolveClient here: the stored grant already pins the client, and a
  // CIMD refetch hiccup must not be able to kill working refresh flows.
  const rotated = await rotateRefreshToken(refreshToken, clientId);

  return Response.json(
    {
      access_token: rotated.accessToken,
      token_type: "Bearer",
      expires_in: rotated.accessTokenExpiresInSeconds,
      refresh_token: rotated.refreshToken ?? undefined,
      scope: rotated.scope,
    },
    { headers: RESPONSE_HEADERS },
  );
}

// Keyed by the presented grant (code or refresh token), which is per-user —
// a CIMD client_id is one fixed URL shared by every user of that connector,
// and connector egress IPs are shared too, so either alone would throttle
// unrelated tenants against each other.
const limiter = new RateLimiter(rateLimitConfigs.analytics);
limiter.start();

export async function POST(request: Request): Promise<Response> {
  try {
    const params = await parseBody(request);

    const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const grant = params.get("refresh_token") ?? params.get("code") ?? "";
    const limit = limiter.consume(grant !== "" ? hashToken(grant) : `ip:${clientIp}`);
    if (!limit.allowed) {
      return Response.json(
        { error: "slow_down", error_description: "too many token requests" },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)),
            ...RESPONSE_HEADERS,
          },
        },
      );
    }

    // Opportunistic cleanup instead of a cron: ~1% of token requests sweep
    // long-expired codes and token rows.
    if (Math.random() < 0.01) {
      pruneExpired().catch(() => {});
    }

    const grantType = require(params, "grant_type");

    if (grantType === "authorization_code") {
      return await handleAuthorizationCode(params);
    }
    if (grantType === "refresh_token") {
      return await handleRefreshToken(params);
    }
    throw new OAuthError("unsupported_grant_type", `unsupported grant_type ${grantType}`, 400);
  } catch (err) {
    if (err instanceof OAuthError) {
      const response = err.toResponse();
      for (const [k, v] of Object.entries(CORS_HEADERS)) response.headers.set(k, v);
      return response;
    }
    console.error("[oauth/token] unexpected error:", err);
    return Response.json(
      { error: "server_error", error_description: "unexpected error" },
      { status: 500, headers: RESPONSE_HEADERS },
    );
  }
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
