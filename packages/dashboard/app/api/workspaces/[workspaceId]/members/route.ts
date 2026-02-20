import { type AuthContext, withRole } from "@/lib/auth/require-role";
import { getDb } from "@/lib/db";
import { users, workspaceMembers } from "@yavio/db/schema";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export const GET = withRole("viewer")(async (_request: Request, ctx: AuthContext) => {
  const db = getDb();

  const rows = await db
    .select({
      id: workspaceMembers.userId,
      email: users.email,
      name: users.name,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.joinedAt,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(eq(workspaceMembers.workspaceId, ctx.workspaceId));

  return NextResponse.json({ members: rows });
});
