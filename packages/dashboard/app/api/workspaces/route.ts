import { getServerSession } from "@/lib/auth/get-session";
import { getDb } from "@/lib/db";
import { slugify } from "@/lib/workspace/slugify";
import { createWorkspaceSchema } from "@/lib/workspace/validation";
import { withRLS } from "@yavio/db/rls";
import { workspaceMembers, workspaces } from "@yavio/db/schema";
import { ErrorCode } from "@yavio/shared/error-codes";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized", code: ErrorCode.DASHBOARD.SESSION_EXPIRED },
      { status: 401 },
    );
  }

  const db = getDb();
  const rows = await withRLS(db, session.userId, async (tx) => {
    return tx
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        plan: workspaces.plan,
        ownerId: workspaces.ownerId,
        createdAt: workspaces.createdAt,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(eq(workspaceMembers.userId, session.userId));
  });

  return NextResponse.json({ workspaces: rows });
}

export async function POST(request: Request) {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized", code: ErrorCode.DASHBOARD.SESSION_EXPIRED },
      { status: 401 },
    );
  }

  const body = await request.json();
  const parsed = createWorkspaceSchema.safeParse(body);
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

  const { name } = parsed.data;
  const slug = parsed.data.slug ?? slugify(name);
  const db = getDb();

  // Check slug uniqueness
  const existing = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.slug, slug))
    .limit(1);

  if (existing.length > 0) {
    return NextResponse.json(
      { error: "Slug already exists", code: ErrorCode.DASHBOARD.WORKSPACE_SLUG_EXISTS },
      { status: 409 },
    );
  }

  const [workspace] = await db.transaction(async (tx) => {
    const [ws] = await tx
      .insert(workspaces)
      .values({ name, slug, ownerId: session.userId })
      .returning();

    await tx.insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: session.userId,
      role: "owner",
    });

    return [ws];
  });

  return NextResponse.json({ workspace }, { status: 201 });
}
