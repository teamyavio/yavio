import { type OAuthClient, resolveClient, validateRedirectUri } from "./clients";
import { ANALYTICS_SCOPE, OFFLINE_ACCESS_SCOPE, mcpResourceUri, oauthIssuer } from "./constants";
import { OAuthError } from "./errors";

/**
 * Authorization-request validation. Failure handling is two-tier (RFC 6749
 * §4.1.2.1): until the redirect_uri itself is proven registered, errors must
 * RENDER (redirecting would build an open redirector); after that, protocol
 * errors REDIRECT back to the client with an error code.
 */

/** Error shown on our own page — never redirected. */
export class RenderAuthorizeError extends Error {
  constructor(public readonly description: string) {
    super(description);
    this.name = "RenderAuthorizeError";
  }
}

/** Error sent back to the (validated) client redirect_uri. */
export class RedirectAuthorizeError extends Error {
  constructor(
    public readonly redirectTo: string,
    public readonly error: string,
    public readonly description: string,
  ) {
    super(`${error}: ${description}`);
    this.name = "RedirectAuthorizeError";
  }
}

export interface AuthorizeRequest {
  client: OAuthClient;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  /** Space-joined scope that will be granted. */
  scope: string;
  resource: string | null;
}

const ALLOWED_SCOPES = new Set([ANALYTICS_SCOPE, OFFLINE_ACCESS_SCOPE]);

function buildRedirect(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(key, value);
  }
  // RFC 9207: identify the issuer in every authorization response.
  url.searchParams.set("iss", oauthIssuer());
  return url.toString();
}

export function successRedirect(request: AuthorizeRequest, code: string): string {
  return buildRedirect(request.redirectUri, { code, state: request.state });
}

export function errorRedirect(
  redirectUri: string,
  state: string | null,
  error: string,
  description: string,
): string {
  return buildRedirect(redirectUri, { error, error_description: description, state });
}

export async function validateAuthorizeRequest(
  params: Record<string, string | undefined>,
): Promise<AuthorizeRequest> {
  const clientId = params.client_id;
  if (!clientId) {
    throw new RenderAuthorizeError("Missing client_id.");
  }

  let client: OAuthClient;
  try {
    client = await resolveClient(clientId);
  } catch (err) {
    if (err instanceof OAuthError) {
      throw new RenderAuthorizeError(`Client could not be verified: ${err.description}`);
    }
    throw err;
  }

  const redirectUri = params.redirect_uri;
  if (!redirectUri) {
    throw new RenderAuthorizeError("Missing redirect_uri.");
  }
  try {
    validateRedirectUri(client, redirectUri);
  } catch {
    throw new RenderAuthorizeError(
      "The redirect address is not registered for this client. For your safety the request was stopped.",
    );
  }

  const state = params.state ?? null;
  const fail = (error: string, description: string): never => {
    throw new RedirectAuthorizeError(
      errorRedirect(redirectUri, state, error, description),
      error,
      description,
    );
  };

  if (params.response_type !== "code") {
    fail("unsupported_response_type", "only response_type=code is supported");
  }
  const codeChallenge = params.code_challenge;
  if (!codeChallenge || !/^[A-Za-z0-9\-_]{43}$/.test(codeChallenge)) {
    fail("invalid_request", "a S256 code_challenge is required");
  }
  if (params.code_challenge_method !== "S256") {
    fail("invalid_request", "code_challenge_method must be S256");
  }

  // RFC 6749 §3.3: the AS may ignore scopes it does not grant. Hard-failing
  // would lock out any client that tacks on `openid`/`profile`/a vendor
  // scope alongside ours — and dropping is not permissive, since only
  // ALLOWED_SCOPES can ever end up in the grant.
  const requested = (params.scope ?? "").split(" ").filter((s) => s.length > 0);
  const granted = requested.filter((scope) => ALLOWED_SCOPES.has(scope));
  if (!granted.includes(ANALYTICS_SCOPE)) granted.unshift(ANALYTICS_SCOPE);

  const resource = params.resource ?? null;
  if (resource !== null && resource !== mcpResourceUri()) {
    fail("invalid_target", "resource does not identify this MCP server");
  }

  return {
    client,
    redirectUri,
    state,
    codeChallenge: codeChallenge as string,
    scope: granted.join(" "),
    resource,
  };
}
