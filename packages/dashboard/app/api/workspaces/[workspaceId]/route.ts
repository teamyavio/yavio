import { type AuthContext, withRole } from "@/lib/auth/require-role";
import { getDb } from "@/lib/db";
import { kickErasure } from "@/lib/erasure";
import { deleteWorkspaceWithErasure } from "@/lib/erasure/requests";
import { updateWorkspaceSchema } from "@/lib/workspace/validation";
import { withRLS } from "@yavio/db/rls";
import { workspaceMembers, workspaces } from "@yavio/db/schema";
import { ErrorCode } from "@yavio/shared/error-codes";
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

export const GET = withRole("viewer")(async (_request: Request, ctx: AuthContext) => {
  const db = getDb();

  const [workspace] = await withRLS(db, ctx.userId, async (tx) => {
    return tx.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId)).limit(1);
  });

  if (!workspace) {
    return NextResponse.json(
      { error: "Workspace not found", code: ErrorCode.DASHBOARD.WORKSPACE_NOT_FOUND },
      { status: 404 },
    );
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, ctx.workspaceId));

  return NextResponse.json({ workspace: { ...workspace, memberCount: count } });
});

export const PATCH = withRole("admin")(async (request: Request, ctx: AuthContext) => {
  const body = await request.json();
  const parsed = updateWorkspaceSchema.safeParse(body);
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

  const db = getDb();
  const values: Record<string, unknown> = { updatedAt: new Date() };

  if (parsed.data.name) values.name = parsed.data.name;
  if (parsed.data.slug) {
    // Check slug uniqueness
    const existing = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.slug, parsed.data.slug))
      .limit(1);

    if (existing.length > 0 && existing[0].id !== ctx.workspaceId) {
      return NextResponse.json(
        { error: "Slug already exists", code: ErrorCode.DASHBOARD.WORKSPACE_SLUG_EXISTS },
        { status: 409 },
      );
    }
    values.slug = parsed.data.slug;
  }

  const [updated] = await db
    .update(workspaces)
    .set(values)
    .where(eq(workspaces.id, ctx.workspaceId))
    .returning();

  return NextResponse.json({ workspace: updated });
});

export const DELETE = withRole("owner")(async (_request: Request, ctx: AuthContext) => {
  if (!ctx.isOwner) {
    return NextResponse.json(
      {
        error: "Only the owner can delete a workspace",
        code: ErrorCode.DASHBOARD.OWNER_CANNOT_BE_REMOVED,
      },
      { status: 403 },
    );
  }

  // Deletes the workspace (cascading members, projects, api keys, invitations)
  // and queues the erasure of its ClickHouse data in one transaction; the
  // erasure worker retries until every table is done.
  await deleteWorkspaceWithErasure(getDb(), ctx.workspaceId);
  kickErasure();

  return NextResponse.json({ message: "Workspace deleted" });
});
