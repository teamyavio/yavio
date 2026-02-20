import { ErrorCode } from "@yavio/shared/error-codes";
import type { WorkspaceRole } from "@yavio/shared/validation";
import { NextResponse } from "next/server";
import { getServerSession } from "./get-session";
import { checkWorkspaceAccess } from "./workspace-access";

const ROLE_HIERARCHY: Record<WorkspaceRole, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

export interface AuthContext {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
  isOwner: boolean;
}

type RouteHandler = (request: Request, context: AuthContext) => Promise<Response> | Response;

export function withRole(minimumRole: WorkspaceRole) {
  return (handler: RouteHandler) => {
    return async (request: Request, routeContext: { params: Promise<{ workspaceId: string }> }) => {
      const session = await getServerSession();
      if (!session) {
        return NextResponse.json(
          { error: "Authentication required", code: ErrorCode.DASHBOARD.SESSION_EXPIRED },
          { status: 401 },
        );
      }

      const { workspaceId } = await routeContext.params;
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
        role: access.role,
        isOwner: access.isOwner,
      });
    };
  };
}
