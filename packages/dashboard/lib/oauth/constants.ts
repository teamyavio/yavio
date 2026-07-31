/** Single read-only scope for all analytics MCP tools. */
export const ANALYTICS_SCOPE = "analytics:read";

/**
 * Advertised in AS metadata `scopes_supported` (that is how Claude and ChatGPT
 * decide to request refresh tokens) but deliberately NOT in protected-resource
 * metadata scopes (spec: SHOULD NOT appear there).
 */
export const OFFLINE_ACCESS_SCOPE = "offline_access";

export const AUTH_CODE_TTL_MS = 60_000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A rotated-out refresh token presented again within this window is treated as
 * a benign client race (Claude/ChatGPT are known to fire parallel refreshes),
 * not as replay. Beyond it, reuse revokes the whole grant family.
 */
export const REFRESH_ROTATION_GRACE_MS = 30_000;

/** How long a fetched CIMD document is trusted before re-fetching. */
export const CIMD_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * How long a cached CIMD document may still be served if the re-fetch fails.
 * Keeps a client's document-host outage from breaking every authorization
 * for that connector; redirect URIs move rarely, so a bounded staleness is a
 * far better trade than hard-failing.
 */
export const CIMD_STALE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Canonical origin of this deployment, no trailing slash. Falls back to
 * NEXTAUTH_URL so a deployment that only sets the auth URL cannot silently
 * mint tokens with a localhost issuer/audience.
 */
export function canonicalOrigin(): string {
  // Same precedence as lib/security/origin.ts. They previously disagreed
  // (APP_URL first here, NEXTAUTH_URL first there), so a deployment setting
  // both to different hosts would mint tokens for an audience its own CSRF
  // check rejects.
  const url = process.env.NEXTAUTH_URL ?? process.env.APP_URL ?? "http://localhost:3000";
  return url.replace(/\/+$/, "");
}

/** OAuth issuer identifier (RFC 8414). */
export function oauthIssuer(): string {
  return canonicalOrigin();
}

/** Canonical MCP resource URI — the RFC 8707 audience tokens are bound to. */
export function mcpResourceUri(): string {
  return `${canonicalOrigin()}/api/mcp`;
}
