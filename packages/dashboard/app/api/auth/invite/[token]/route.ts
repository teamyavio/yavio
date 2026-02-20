import { getDb } from "@/lib/db";
import { hashInviteToken } from "@/lib/invitation/token";
import { invitations, workspaces } from "@yavio/db/schema";
import { ErrorCode } from "@yavio/shared/error-codes";
import { and, eq, gt, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function GET(_request: Request, routeContext: { params: Promise<{ token: string }> }) {
  const { token } = await routeContext.params;
  const tokenHash = hashInviteToken(token);
  const db = getDb();

  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      expiresAt: invitations.expiresAt,
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      workspaceSlug: workspaces.slug,
    })
    .from(invitations)
    .innerJoin(workspaces, eq(invitations.workspaceId, workspaces.id))
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
  return NextResponse.json({
    invitation: {
      id: invite.id,
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expiresAt,
      workspace: {
        id: invite.workspaceId,
        name: invite.workspaceName,
        slug: invite.workspaceSlug,
      },
    },
  });
}
