import { type AuthContext, withRole } from "@/lib/auth/require-role";
import { getDb } from "@/lib/db";
import { generateInviteToken } from "@/lib/invitation/token";
import { inviteSchema } from "@/lib/invitation/validation";
import { invitations, users, workspaceMembers } from "@yavio/db/schema";
import { ErrorCode } from "@yavio/shared/error-codes";
import { and, eq, gt, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

export const POST = withRole("admin")(async (request: Request, ctx: AuthContext) => {
  const body = await request.json();
  const parsed = inviteSchema.safeParse(body);
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

  const { email, role } = parsed.data;
  const db = getDb();

  // Check if the user is already a member of this workspace
  const existingUser = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existingUser.length > 0) {
    const existingMember = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, ctx.workspaceId),
          eq(workspaceMembers.userId, existingUser[0].id),
        ),
      )
      .limit(1);

    if (existingMember.length > 0) {
      return NextResponse.json(
        { error: "User is already a member", code: ErrorCode.DASHBOARD.USER_ALREADY_MEMBER },
        { status: 409 },
      );
    }
  }

  // Check for a pending invitation for this email in this workspace
  const pendingInvite = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.workspaceId, ctx.workspaceId),
        eq(invitations.email, email),
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (pendingInvite.length > 0) {
    return NextResponse.json(
      {
        error: "An invitation is already pending for this email",
        code: ErrorCode.DASHBOARD.INVITATION_ALREADY_PENDING,
      },
      { status: 409 },
    );
  }

  // Generate invite token and create invitation
  const { raw, hash } = generateInviteToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const [invitation] = await db
    .insert(invitations)
    .values({
      workspaceId: ctx.workspaceId,
      email,
      role,
      invitedBy: ctx.userId,
      token: hash,
      expiresAt,
    })
    .returning();

  return NextResponse.json(
    { invitation: { id: invitation.id, email, role, expiresAt }, token: raw },
    { status: 201 },
  );
});
