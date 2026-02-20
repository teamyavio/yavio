import { type AuthContext, withRole } from "@/lib/auth/require-role";
import { getDb } from "@/lib/db";
import { invitations } from "@yavio/db/schema";
import { and, eq, gt, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

export const GET = withRole("admin")(async (_request: Request, ctx: AuthContext) => {
  const db = getDb();

  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      invitedBy: invitations.invitedBy,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .where(
      and(
        eq(invitations.workspaceId, ctx.workspaceId),
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    );

  return NextResponse.json({ invitations: rows });
});
