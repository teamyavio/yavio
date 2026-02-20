import { getServerSession } from "@/lib/auth/get-session";
import { checkWorkspaceAccess } from "@/lib/auth/workspace-access";
import { getDb } from "@/lib/db";
import { invitations } from "@yavio/db/schema";
import { ErrorCode } from "@yavio/shared/error-codes";
import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

type RouteParams = { params: Promise<{ workspaceId: string; invitationId: string }> };

export async function DELETE(_request: Request, routeContext: RouteParams) {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json(
      { error: "Authentication required", code: ErrorCode.DASHBOARD.SESSION_EXPIRED },
      { status: 401 },
    );
  }

  const { workspaceId, invitationId } = await routeContext.params;

  const access = await checkWorkspaceAccess(session.userId, workspaceId);
  if (!access) {
    return NextResponse.json(
      { error: "Not a member of this workspace", code: ErrorCode.DASHBOARD.NOT_A_MEMBER },
      { status: 403 },
    );
  }

  if (access.role !== "admin" && access.role !== "owner") {
    return NextResponse.json(
      { error: "Insufficient role", code: ErrorCode.DASHBOARD.INSUFFICIENT_ROLE },
      { status: 403 },
    );
  }

  const db = getDb();

  // Only delete pending (not yet accepted) invitations
  const result = await db
    .delete(invitations)
    .where(
      and(
        eq(invitations.id, invitationId),
        eq(invitations.workspaceId, workspaceId),
        isNull(invitations.acceptedAt),
      ),
    )
    .returning({ id: invitations.id });

  if (result.length === 0) {
    return NextResponse.json(
      { error: "Invitation not found", code: ErrorCode.DASHBOARD.INVITATION_NOT_FOUND },
      { status: 404 },
    );
  }

  return NextResponse.json({ message: "Invitation cancelled" });
}
