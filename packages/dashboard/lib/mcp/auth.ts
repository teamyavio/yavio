import { checkWorkspaceAccess } from "@/lib/auth/workspace-access";
import { mcpResourceUri } from "@/lib/oauth/constants";
import { verifyAccessToken } from "@/lib/oauth/store";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { WorkspaceRole } from "@yavio/shared/validation";

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

  const verified = await verifyAccessToken(bearerToken);
  if (!verified) return undefined;

  // RFC 8707: the token must have been minted for exactly this resource.
  if (verified.audience !== mcpResourceUri()) return undefined;

  // Live membership re-check: removing someone from a workspace kills their
  // connector access on the next call, not at token expiry.
  const access = await checkWorkspaceAccess(verified.userId, verified.workspaceId);
  if (!access) return undefined;

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
