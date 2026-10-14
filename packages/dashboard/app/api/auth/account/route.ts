import { changePasswordSchema, updateProfileSchema } from "@/lib/account/validation";
import { getServerSession } from "@/lib/auth/get-session";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { getDb } from "@/lib/db";
import { kickErasure } from "@/lib/erasure";
import { deleteAccountWithErasure } from "@/lib/erasure/requests";
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

  // Deletes the user (cascading sessions, memberships, oauth accounts), their
  // owned workspaces and the invitations they sent, and queues the erasure of
  // each owned workspace's ClickHouse data — in one transaction; the erasure
  // worker retries until done.
  await deleteAccountWithErasure(db, session.userId);
  kickErasure();

  return NextResponse.json({ message: "Account deleted" });
}
