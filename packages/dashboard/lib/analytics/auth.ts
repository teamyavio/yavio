import { getServerSession } from "@/lib/auth/get-session";
import { checkWorkspaceAccess } from "@/lib/auth/workspace-access";
import { getDb } from "@/lib/db";
import { projects } from "@yavio/db/schema";
import { ErrorCode } from "@yavio/shared/error-codes";
import type { WorkspaceRole } from "@yavio/shared/validation";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

const ROLE_HIERARCHY: Record<WorkspaceRole, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

export interface AnalyticsAuthContext {
  userId: string;
  workspaceId: string;
  projectId: string;
  role: WorkspaceRole;
}

type AnalyticsRouteHandler = (
  request: Request,
  context: AnalyticsAuthContext,
) => Promise<Response> | Response;

/**
 * Higher-order function for analytics API routes.
 *
 * Resolves `projectId` from route params, looks up the workspace,
 * checks session + membership + minimum role.
 */
export function withAnalyticsAuth(minimumRole: WorkspaceRole) {
  return (handler: AnalyticsRouteHandler) => {
    return async (request: Request, routeContext: { params: Promise<{ projectId: string }> }) => {
      const session = await getServerSession();
      if (!session) {
        return NextResponse.json(
          { error: "Authentication required", code: ErrorCode.DASHBOARD.SESSION_EXPIRED },
          { status: 401 },
        );
      }

      const { projectId } = await routeContext.params;

      const db = getDb();
      const rows = await db
        .select({ workspaceId: projects.workspaceId })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);

      if (rows.length === 0) {
        return NextResponse.json(
          { error: "Project not found", code: ErrorCode.DASHBOARD.PROJECT_NOT_FOUND },
          { status: 404 },
        );
      }

      const workspaceId = rows[0].workspaceId;
      const access = await checkWorkspaceAccess(session.userId, workspaceId);
      if (!access) {
        return NextResponse.json(
          { error: "Not a member of this workspace", code: ErrorCode.DASHBOARD.NOT_A_MEMBER },
          { status: 403 },
        );
      }

      if (ROLE_HIERARCHY[access.role] < ROLE_HIERARCHY[minimumRole]) {
        return NextResponse.json(
          { error: "Insufficient role", code: ErrorCode.DASHBOARD.INSUFFICIENT_ROLE },
          { status: 403 },
        );
      }

      return handler(request, {
        userId: session.userId,
        workspaceId,
        projectId,
        role: access.role,
      });
    };
  };
}
