import {
  ANALYTICS_SCOPE,
  OFFLINE_ACCESS_SCOPE,
  canonicalOrigin,
  mcpResourceUri,
  oauthIssuer,
} from "./constants";

/**
 * RFC 8414 authorization-server metadata.
 *
 * Claude's CIMD gate requires BOTH `client_id_metadata_document_supported:
 * true` AND `"none"` in `token_endpoint_auth_methods_supported`; if either is
 * missing it silently falls back to DCR. `offline_access` in scopes_supported
 * is how Claude and ChatGPT decide to request refresh tokens.
 */
export function authorizationServerMetadata(): Record<string, unknown> {
  const origin = canonicalOrigin();
  return {
    issuer: oauthIssuer(),
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    revocation_endpoint_auth_methods_supported: ["none"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [ANALYTICS_SCOPE, OFFLINE_ACCESS_SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * RFC 9728 protected-resource metadata. Served path-aware at
 * /.well-known/oauth-protected-resource/api/mcp and at the root fallback.
 * Deliberately no offline_access here (spec: SHOULD NOT), and only the first
 * authorization_servers entry matters to Claude.
 */
export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: mcpResourceUri(),
    authorization_servers: [oauthIssuer()],
    scopes_supported: [ANALYTICS_SCOPE],
    bearer_methods_supported: ["header"],
  };
}

/** Shared headers for discovery endpoints: public, CORS-open, cacheable briefly. */
export const DISCOVERY_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=300",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-protocol-version",
};
