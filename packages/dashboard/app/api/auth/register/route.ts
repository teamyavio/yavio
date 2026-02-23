import { hashPassword } from "@/lib/auth/password";
import { registerSchema } from "@/lib/auth/validation";
import { getDb } from "@/lib/db";
import { projects, users, workspaceMembers, workspaces } from "@yavio/db/schema";
import { ErrorCode } from "@yavio/shared/error-codes";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = registerSchema.safeParse(body);

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

  const { name, email, password } = parsed.data;
  const db = getDb();

  // Check if email is already registered
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing.length > 0) {
    return NextResponse.json(
      { error: "Email already registered", code: ErrorCode.DASHBOARD.EMAIL_ALREADY_REGISTERED },
      { status: 409 },
    );
  }

  const passwordHash = await hashPassword(password);

  // Create user, default workspace, and membership in a transaction
  await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ email, name, passwordHash, emailVerified: !process.env.SMTP_HOST })
      .returning({ id: users.id });

    const slug = email
      .split("@")[0]
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 48);
    const workspaceName = `${name}'s Workspace`;

    const [workspace] = await tx
      .insert(workspaces)
      .values({ name: workspaceName, slug: `${slug}-${user.id.slice(0, 8)}`, ownerId: user.id })
      .returning({ id: workspaces.id });

    await tx.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId: user.id,
      role: "owner",
    });

    await tx.insert(projects).values({
      workspaceId: workspace.id,
      name: "Default Project",
      slug: "default",
    });
  });

  return NextResponse.json({ message: "Account created" }, { status: 201 });
}
