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
 */
export class McpUnavailableError extends Error {
  constructor() {
    super("token verification is temporarily unavailable");
    this.name = "McpUnavailableError";
  }
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
export async function verifyMcpBearerToken(
  _req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;

  // mcp-handler turns ANY throw from here into 401 invalid_token — the code
  // clients treat as "this grant is dead, re-authorize". A database blip must
  // not do that to every connected user at once, so infrastructure failures
  // are re-thrown as McpUnavailableError, which the route maps to 503.
  let verified: Awaited<ReturnType<typeof verifyAccessToken>>;
  let access: Awaited<ReturnType<typeof checkWorkspaceAccess>>;
  try {
    verified = await verifyAccessToken(bearerToken);
    // RFC 8707: the token must have been minted for exactly this resource.
    if (!verified || verified.audience !== mcpResourceUri()) return undefined;

    // Live membership re-check: removing someone from a workspace kills their
    // connector access on the next call, not at token expiry.
    access = await checkWorkspaceAccess(verified.userId, verified.workspaceId);
  } catch (err) {
    console.error("[mcp] token verification failed for infrastructure reasons:", err);
    throw new McpUnavailableError();
  }
  if (!access) return undefined;

  // Same floor the analytics HTTP routes enforce. A no-op today (every role
  // is >= viewer) but keeps the two surfaces from silently diverging.
  if (ROLE_HIERARCHY[access.role] < ROLE_HIERARCHY.viewer) return undefined;

  const context: McpAuthContext = {
    userId: verified.userId,
    workspaceId: verified.workspaceId,
    role: access.role,
  };

  return {
    token: bearerToken,
    clientId: verified.clientId,
    scopes: verified.scope.split(" "),
    extra: context as unknown as Record<string, unknown>,
  };
}

/** Pulls the auth context a tool handler needs out of the SDK's extra bag. */
export function mcpAuthContext(authInfo: AuthInfo | undefined): McpAuthContext {
  const extra = authInfo?.extra as McpAuthContext | undefined;
  if (!extra?.userId || !extra?.workspaceId) {
    throw new Error("MCP tool invoked without an authenticated context");
  }
  return extra;
}
