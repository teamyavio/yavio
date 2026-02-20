import { getServerSession } from "@/lib/auth/get-session";
import { getDb } from "@/lib/db";
import { hashInviteToken } from "@/lib/invitation/token";
import { invitations, workspaceMembers } from "@yavio/db/schema";
import { ErrorCode } from "@yavio/shared/error-codes";
import { and, eq, gt, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function POST(
  _request: Request,
  routeContext: { params: Promise<{ token: string }> },
) {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json(
      { error: "Authentication required", code: ErrorCode.DASHBOARD.SESSION_EXPIRED },
      { status: 401 },
    );
  }

  const { token } = await routeContext.params;
  const tokenHash = hashInviteToken(token);
  const db = getDb();

  // Find valid invitation
  const rows = await db
    .select({
      id: invitations.id,
      workspaceId: invitations.workspaceId,
      email: invitations.email,
      role: invitations.role,
    })
    .from(invitations)
    .where(
      and(
        eq(invitations.token, tokenHash),
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json(
      {
        error: "Invalid or expired invitation",
        code: ErrorCode.DASHBOARD.INVALID_INVITE_TOKEN,
      },
      { status: 404 },
    );
  }

  const invite = rows[0];

  // Check if user is already a member
  const existingMember = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, invite.workspaceId),
        eq(workspaceMembers.userId, session.userId),
      ),
    )
    .limit(1);

  if (existingMember.length > 0) {
    return NextResponse.json(
      {
        error: "You are already a member of this workspace",
        code: ErrorCode.DASHBOARD.USER_ALREADY_MEMBER,
      },
      { status: 409 },
    );
  }

  // Accept invitation in a transaction
  await db.transaction(async (tx) => {
    await tx.insert(workspaceMembers).values({
      workspaceId: invite.workspaceId,
      userId: session.userId,
      role: invite.role,
    });

    await tx
      .update(invitations)
      .set({ acceptedAt: new Date() })
      .where(eq(invitations.id, invite.id));
  });

  return NextResponse.json({
    message: "Invitation accepted",
    workspaceId: invite.workspaceId,
  });
}
