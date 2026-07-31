import { ROLE_HIERARCHY } from "@/lib/auth/role-hierarchy";
import { checkWorkspaceAccess } from "@/lib/auth/workspace-access";
import { mcpResourceUri } from "@/lib/oauth/constants";
import { verifyAccessToken } from "@/lib/oauth/store";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { WorkspaceRole } from "@yavio/shared/validation";

/**
 * Raised when the token could not be checked at all (database down, pool
 * exhausted). Distinct from "the token is bad" so the route can answer 503
 * instead of telling every client its grant is dead.
 *
 * It must be raised BEFORE mcp-handler sees the request: withMcpAuth wraps
 * verifyToken in its own try/catch and turns every throw into 401
 * invalid_token, which clients read as "re-authorize". So the route runs
 * `preflightMcpAuth` first and mcp-handler only ever gets a cached answer.
 */
export class McpUnavailableError extends Error {
  constructor() {
    super("token verification is temporarily unavailable");
    this.name = "McpUnavailableError";
  }
}

/**
 * Per-request memo so the verification runs once even though both the
 * preflight and mcp-handler ask for it. Keyed by the Request object, so
 * entries disappear with the request.
 */
const verified = new WeakMap<Request, AuthInfo | undefined>();

function bearerFrom(request: Request): string | undefined {
  const [type, token] = request.headers.get("authorization")?.split(" ") ?? [];
  return type?.toLowerCase() === "bearer" ? token : undefined;
}

/**
 * Verify ahead of mcp-handler so infrastructure failures can surface as 503.
 * Throws McpUnavailableError; never throws for a merely invalid token.
 */
export async function preflightMcpAuth(request: Request): Promise<void> {
  verified.set(request, await resolveBearer(bearerFrom(request)));
}

export interface McpAuthContext {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
}

/**
 * Bearer verification for /api/mcp, plugged into withMcpAuth. Returning
 * undefined produces the 401 + WWW-Authenticate challenge that sends clients
 * into the OAuth flow.
 */
async function resolveBearer(bearerToken?: string): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;

  let token: Awaited<ReturnType<typeof verifyAccessToken>>;
  let access: Awaited<ReturnType<typeof checkWorkspaceAccess>>;
  try {
    token = await verifyAccessToken(bearerToken);
    // RFC 8707: the token must have been minted for exactly this resource.
    if (!token || token.audience !== mcpResourceUri()) return undefined;

    // Live membership re-check: removing someone from a workspace kills their
    // connector access on the next call, not at token expiry.
    access = await checkWorkspaceAccess(token.userId, token.workspaceId);
  } catch (err) {
    console.error("[mcp] token verification failed for infrastructure reasons:", err);
    throw new McpUnavailableError();
  }
  if (!access) return undefined;

  // Same floor the analytics HTTP routes enforce. A no-op today (every role
  // is >= viewer) but keeps the two surfaces from silently diverging.
  if (ROLE_HIERARCHY[access.role] < ROLE_HIERARCHY.viewer) return undefined;

  const context: McpAuthContext = {
    userId: token.userId,
    workspaceId: token.workspaceId,
    role: access.role,
  };

  return {
    token: bearerToken,
    clientId: token.clientId,
    scopes: token.scope.split(" "),
    extra: context as unknown as Record<string, unknown>,
  };
}

/**
 * The hook mcp-handler calls. It returns the answer the preflight already
 * computed, so a database failure has surfaced as 503 before we get here and
 * mcp-handler's catch-all-throws-as-401 never sees an infrastructure error.
 */
export async function verifyMcpBearerToken(
  req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> {
  if (verified.has(req)) return verified.get(req);
  return resolveBearer(bearerToken);
}

/** Pulls the auth context a tool handler needs out of the SDK's extra bag. */
export function mcpAuthContext(authInfo: AuthInfo | undefined): McpAuthContext {
  const extra = authInfo?.extra as McpAuthContext | undefined;
  if (!extra?.userId || !extra?.workspaceId) {
    throw new Error("MCP tool invoked without an authenticated context");
  }
  return extra;
}
