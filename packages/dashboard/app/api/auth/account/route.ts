import { getServerSession } from "@/lib/auth/get-session";
import { verifyPassword } from "@/lib/auth/password";
import { getDb } from "@/lib/db";
import { users, workspaces } from "@yavio/db/schema";
import { ErrorCode } from "@yavio/shared/error-codes";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function DELETE(request: Request) {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized", code: ErrorCode.DASHBOARD.SESSION_EXPIRED },
      { status: 401 },
    );
  }

  const body = await request.json();
  const password = body.password as string | undefined;

  if (!password) {
    return NextResponse.json(
      {
        error: "Password confirmation required",
        code: ErrorCode.DASHBOARD.ACCOUNT_DELETION_REQUIRES_PASSWORD,
      },
      { status: 400 },
    );
  }

  const db = getDb();

  // Verify password
  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!user?.passwordHash) {
    return NextResponse.json(
      { error: "Invalid password", code: ErrorCode.DASHBOARD.INVALID_PASSWORD },
      { status: 400 },
    );
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return NextResponse.json(
      { error: "Invalid password", code: ErrorCode.DASHBOARD.INVALID_PASSWORD },
      { status: 400 },
    );
  }

  // Get owned workspaces for ClickHouse cleanup
  const ownedWorkspaces = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.ownerId, session.userId));

  // Delete user (cascades sessions, workspace memberships, oauth accounts)
  // Owned workspaces cascade via foreign key
  await db.delete(users).where(eq(users.id, session.userId));

  // Clean up ClickHouse data for owned workspaces
  try {
    const { getClickHouseClient } = await import("@/lib/clickhouse");
    const ch = getClickHouseClient();
    for (const ws of ownedWorkspaces) {
      await ch.command({
        query: "ALTER TABLE events DELETE WHERE workspace_id = {id:String}",
        query_params: { id: ws.id },
      });
    }
  } catch {
    console.error("Failed to clean ClickHouse data during account deletion");
  }

  return NextResponse.json({ message: "Account deleted" });
}
