import { createHash, randomBytes } from "node:crypto";
import { forgotPasswordSchema } from "@/lib/auth/validation";
import { getDb } from "@/lib/db";
import { users, verificationTokens } from "@yavio/db/schema";
import { ErrorCode } from "@yavio/shared/error-codes";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = forgotPasswordSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid email", code: ErrorCode.DASHBOARD.VALIDATION_FAILED },
      { status: 400 },
    );
  }

  const { email } = parsed.data;
  const db = getDb();

  // Always return success to prevent email enumeration
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (user) {
    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    await db.insert(verificationTokens).values({
      userId: user.id,
      tokenHash,
      type: "password_reset",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
    });

    // TODO: Send email with reset link containing rawToken
    // For now, log in non-production
    if (process.env.NODE_ENV !== "production") {
      console.log(`Password reset token for ${email}: ${rawToken}`);
    }
  }

  return NextResponse.json({ message: "If an account exists, a reset link was sent." });
}
