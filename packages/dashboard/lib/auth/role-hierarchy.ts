import type { WorkspaceRole } from "@yavio/shared/validation";

/**
 * Workspace role ordering, shared by the HTTP analytics routes and the MCP
 * resource server. Kept free of next-auth imports so the MCP path does not
 * pull the session machinery into its module graph.
 */
export const ROLE_HIERARCHY: Record<WorkspaceRole, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};
