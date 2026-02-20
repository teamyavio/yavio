import { createHash } from "node:crypto";
import { getDb } from "@/lib/db";
import { users, verificationTokens } from "@yavio/db/schema";
import { ErrorCode } from "@yavio/shared/error-codes";
import { and, eq, gt, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return NextResponse.json(
      { error: "Token required", code: ErrorCode.DASHBOARD.VALIDATION_FAILED },
      { status: 400 },
    );
  }

  const db = getDb();
  const tokenHash = createHash("sha256").update(token).digest("hex");

  const [record] = await db
    .select({ id: verificationTokens.id, userId: verificationTokens.userId })
    .from(verificationTokens)
    .where(
      and(
        eq(verificationTokens.tokenHash, tokenHash),
        eq(verificationTokens.type, "email_verification"),
        isNull(verificationTokens.usedAt),
        gt(verificationTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!record) {
    return NextResponse.json(
      {
        error: "Invalid or expired token",
        code: ErrorCode.DASHBOARD.INVALID_EMAIL_VERIFICATION_TOKEN,
      },
      { status: 400 },
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ emailVerified: true, updatedAt: new Date() })
      .where(eq(users.id, record.userId));
    await tx
      .update(verificationTokens)
      .set({ usedAt: new Date() })
      .where(eq(verificationTokens.id, record.id));
  });

  return NextResponse.json({ message: "Email verified successfully" });
}
