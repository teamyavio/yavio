import { createHash } from "node:crypto";
import { hashPassword } from "@/lib/auth/password";
import { resetPasswordSchema } from "@/lib/auth/validation";
import { getDb } from "@/lib/db";
import { users, verificationTokens } from "@yavio/db/schema";
import { ErrorCode } from "@yavio/shared/error-codes";
import { and, eq, gt, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = resetPasswordSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", code: ErrorCode.DASHBOARD.VALIDATION_FAILED },
      { status: 400 },
    );
  }

  const { token, password } = parsed.data;
  const db = getDb();
  const tokenHash = createHash("sha256").update(token).digest("hex");

  const [record] = await db
    .select({ id: verificationTokens.id, userId: verificationTokens.userId })
    .from(verificationTokens)
    .where(
      and(
        eq(verificationTokens.tokenHash, tokenHash),
        eq(verificationTokens.type, "password_reset"),
        isNull(verificationTokens.usedAt),
        gt(verificationTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!record) {
    return NextResponse.json(
      { error: "Invalid or expired token", code: ErrorCode.DASHBOARD.INVALID_PASSWORD_RESET_TOKEN },
      { status: 400 },
    );
  }

  const passwordHash = await hashPassword(password);

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, record.userId));
    await tx
      .update(verificationTokens)
      .set({ usedAt: new Date() })
      .where(eq(verificationTokens.id, record.id));
  });

  return NextResponse.json({ message: "Password reset successfully" });
}
