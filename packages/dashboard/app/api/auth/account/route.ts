import { changePasswordSchema, updateProfileSchema } from "@/lib/account/validation";
import { getServerSession } from "@/lib/auth/get-session";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { getDb } from "@/lib/db";
import { users, workspaces } from "@yavio/db/schema";
import { ErrorCode } from "@yavio/shared/error-codes";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function PATCH(request: Request) {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized", code: ErrorCode.DASHBOARD.SESSION_EXPIRED },
      { status: 401 },
    );
  }

  const body = await request.json();
  const db = getDb();

  // Password change
  if (body.currentPassword || body.newPassword) {
    const parsed = changePasswordSchema.safeParse(body);
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

    const [user] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    if (!user?.passwordHash) {
      return NextResponse.json(
        {
          error: "Cannot change password for OAuth accounts",
          code: ErrorCode.DASHBOARD.INVALID_PASSWORD,
        },
        { status: 400 },
      );
    }

    const valid = await verifyPassword(parsed.data.currentPassword, user.passwordHash);
    if (!valid) {
      return NextResponse.json(
        {
          error: "Current password is incorrect",
          code: ErrorCode.DASHBOARD.INVALID_PASSWORD,
        },
        { status: 400 },
      );
    }

    const newHash = await hashPassword(parsed.data.newPassword);
    await db
      .update(users)
      .set({ passwordHash: newHash, updatedAt: new Date() })
      .where(eq(users.id, session.userId));

    return NextResponse.json({ message: "Password updated" });
  }

  // Profile update (name)
  const parsed = updateProfileSchema.safeParse(body);
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

  const [updated] = await db
    .update(users)
    .set({ name: parsed.data.name, updatedAt: new Date() })
    .where(eq(users.id, session.userId))
    .returning({
      id: users.id,
      name: users.name,
      email: users.email,
    });

  return NextResponse.json({ user: updated });
}

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
  const confirmEmail = body.confirmEmail as string | undefined;

  const db = getDb();

  // Verify identity
  const [user] = await db
    .select({ passwordHash: users.passwordHash, email: users.email })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!user) {
    return NextResponse.json(
      { error: "User not found", code: ErrorCode.DASHBOARD.INVALID_PASSWORD },
      { status: 400 },
    );
  }

  if (user.passwordHash) {
    // Password-based account: require password confirmation
    if (!password) {
      return NextResponse.json(
        {
          error: "Password confirmation required",
          code: ErrorCode.DASHBOARD.ACCOUNT_DELETION_REQUIRES_PASSWORD,
        },
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
  } else {
    // OAuth account: require email confirmation
    if (!confirmEmail || confirmEmail !== user.email) {
      return NextResponse.json(
        {
          error: "Please enter your email address to confirm deletion",
          code: ErrorCode.DASHBOARD.ACCOUNT_DELETION_REQUIRES_PASSWORD,
        },
        { status: 400 },
      );
    }
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
