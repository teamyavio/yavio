import { type AuthContext, withRole } from "@/lib/auth/require-role";
import { getDb } from "@/lib/db";
import { createProjectSchema } from "@/lib/project/validation";
import { slugify } from "@/lib/workspace/slugify";
import { projects } from "@yavio/db/schema";
import { ErrorCode } from "@yavio/shared/error-codes";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export const POST = withRole("member")(async (request: Request, ctx: AuthContext) => {
  const body = await request.json();
  const parsed = createProjectSchema.safeParse(body);
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

  // Check slug uniqueness within workspace
  const existing = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.workspaceId, ctx.workspaceId), eq(projects.slug, slug)))
    .limit(1);

  if (existing.length > 0) {
    return NextResponse.json(
      { error: "Project slug already exists", code: ErrorCode.DASHBOARD.PROJECT_SLUG_EXISTS },
      { status: 409 },
    );
  }

  const [project] = await db
    .insert(projects)
    .values({ name, slug, workspaceId: ctx.workspaceId })
    .returning();

  return NextResponse.json({ project }, { status: 201 });
});

export const GET = withRole("viewer")(async (_request: Request, ctx: AuthContext) => {
  const db = getDb();

  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
    })
    .from(projects)
    .where(eq(projects.workspaceId, ctx.workspaceId));

  return NextResponse.json({ projects: rows });
});
