import { getServerSession } from "@/lib/auth/get-session";
import { checkWorkspaceAccess } from "@/lib/auth/workspace-access";
import { getDb } from "@/lib/db";
import { workspaceMembers, workspaces } from "@yavio/db/schema";
import { ErrorCode } from "@yavio/shared/error-codes";
import { WorkspaceRole } from "@yavio/shared/validation";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

const updateRoleSchema = z.object({
  role: WorkspaceRole.exclude(["owner"]),
});

type RouteParams = { params: Promise<{ workspaceId: string; memberId: string }> };

async function authorize(routeContext: RouteParams) {
  const session = await getServerSession();
  if (!session) {
    return {
      error: NextResponse.json(
        { error: "Authentication required", code: ErrorCode.DASHBOARD.SESSION_EXPIRED },
        { status: 401 },
      ),
    };
  }

  const { workspaceId, memberId } = await routeContext.params;

  const access = await checkWorkspaceAccess(session.userId, workspaceId);
  if (!access) {
    return {
      error: NextResponse.json(
        { error: "Not a member of this workspace", code: ErrorCode.DASHBOARD.NOT_A_MEMBER },
        { status: 403 },
      ),
    };
  }

  if (access.role !== "admin" && access.role !== "owner") {
    return {
      error: NextResponse.json(
        { error: "Insufficient role", code: ErrorCode.DASHBOARD.INSUFFICIENT_ROLE },
        { status: 403 },
      ),
    };
  }

  return { session, workspaceId, memberId, access };
}

export async function PATCH(request: Request, routeContext: RouteParams) {
  const auth = await authorize(routeContext);
  if ("error" in auth) return auth.error;

  const { workspaceId, memberId } = auth;

  const body = await request.json();
  const parsed = updateRoleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        code: ErrorCode.DASHBOARD.VALIDATION_FAILED,
        details: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  const db = getDb();

  // Check if the target member is the workspace owner
  const [workspace] = await db
    .select({ ownerId: workspaces.ownerId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (workspace && workspace.ownerId === memberId) {
    return NextResponse.json(
      {
        error: "Cannot change the owner's role",
        code: ErrorCode.DASHBOARD.OWNER_CANNOT_BE_REMOVED,
      },
      { status: 403 },
    );
  }

  // Verify the member exists
  const existing = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, memberId)),
    )
    .limit(1);

  if (existing.length === 0) {
    return NextResponse.json(
      { error: "Member not found", code: ErrorCode.DASHBOARD.MEMBER_NOT_FOUND },
      { status: 404 },
    );
  }

  await db
    .update(workspaceMembers)
    .set({ role: parsed.data.role })
    .where(
      and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, memberId)),
    );

  return NextResponse.json({ message: "Role updated", role: parsed.data.role });
}

export async function DELETE(_request: Request, routeContext: RouteParams) {
  const auth = await authorize(routeContext);
  if ("error" in auth) return auth.error;

  const { workspaceId, memberId } = auth;
  const db = getDb();

  // Check if the target member is the workspace owner
  const [workspace] = await db
    .select({ ownerId: workspaces.ownerId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (workspace && workspace.ownerId === memberId) {
    return NextResponse.json(
      {
        error: "Cannot remove the workspace owner",
        code: ErrorCode.DASHBOARD.OWNER_CANNOT_BE_REMOVED,
      },
      { status: 403 },
    );
  }

  // Verify the member exists
  const existing = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, memberId)),
    )
    .limit(1);

  if (existing.length === 0) {
    return NextResponse.json(
      { error: "Member not found", code: ErrorCode.DASHBOARD.MEMBER_NOT_FOUND },
      { status: 404 },
    );
  }

  await db
    .delete(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, memberId)),
    );

  return NextResponse.json({ message: "Member removed" });
}
