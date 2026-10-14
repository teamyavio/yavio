import { getServerSession } from "@/lib/auth/get-session";
import { checkWorkspaceAccess } from "@/lib/auth/workspace-access";
import { getDb } from "@/lib/db";
import { kickErasure } from "@/lib/erasure";
import { deleteProjectWithErasure } from "@/lib/erasure/requests";
import { updateProjectSchema } from "@/lib/project/validation";
import { projects } from "@yavio/db/schema";
import { ErrorCode } from "@yavio/shared/error-codes";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

type RouteContext = { params: Promise<{ workspaceId: string; projectId: string }> };

async function authenticate(routeContext: RouteContext) {
  const session = await getServerSession();
  if (!session) {
    return {
      error: NextResponse.json(
        { error: "Authentication required", code: ErrorCode.DASHBOARD.SESSION_EXPIRED },
        { status: 401 },
      ),
    };
  }

  const { workspaceId, projectId } = await routeContext.params;
  const access = await checkWorkspaceAccess(session.userId, workspaceId);
  if (!access) {
    return {
      error: NextResponse.json(
        { error: "Not a member of this workspace", code: ErrorCode.DASHBOARD.NOT_A_MEMBER },
        { status: 403 },
      ),
    };
  }

  return { session, workspaceId, projectId, access };
}

export async function GET(_request: Request, routeContext: RouteContext) {
  const auth = await authenticate(routeContext);
  if ("error" in auth) return auth.error;

  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, auth.projectId), eq(projects.workspaceId, auth.workspaceId)))
    .limit(1);

  if (!project) {
    return NextResponse.json(
      { error: "Project not found", code: ErrorCode.DASHBOARD.PROJECT_NOT_FOUND },
      { status: 404 },
    );
  }

  return NextResponse.json({ project });
}

export async function PATCH(request: Request, routeContext: RouteContext) {
  const auth = await authenticate(routeContext);
  if ("error" in auth) return auth.error;

  if (auth.access.role === "viewer") {
    return NextResponse.json(
      { error: "Insufficient role", code: ErrorCode.DASHBOARD.INSUFFICIENT_ROLE },
      { status: 403 },
    );
  }

  const body = await request.json();
  const parsed = updateProjectSchema.safeParse(body);
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
  // Shorter retention (#93): ingest's statistics job deletes the older raw
  // events at its next daily run, after aggregating them.
  if (parsed.data.retentionMonths !== undefined) {
    values.retentionMonths = parsed.data.retentionMonths;
  }
  if (parsed.data.slug) {
    // Check slug uniqueness within workspace
    const existing = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.workspaceId, auth.workspaceId), eq(projects.slug, parsed.data.slug)))
      .limit(1);

    if (existing.length > 0 && existing[0].id !== auth.projectId) {
      return NextResponse.json(
        { error: "Project slug already exists", code: ErrorCode.DASHBOARD.PROJECT_SLUG_EXISTS },
        { status: 409 },
      );
    }
    values.slug = parsed.data.slug;
  }

  const [updated] = await db
    .update(projects)
    .set(values)
    .where(and(eq(projects.id, auth.projectId), eq(projects.workspaceId, auth.workspaceId)))
    .returning();

  if (!updated) {
    return NextResponse.json(
      { error: "Project not found", code: ErrorCode.DASHBOARD.PROJECT_NOT_FOUND },
      { status: 404 },
    );
  }

  return NextResponse.json({ project: updated });
}

export async function DELETE(_request: Request, routeContext: RouteContext) {
  const auth = await authenticate(routeContext);
  if ("error" in auth) return auth.error;

  if (auth.access.role === "viewer") {
    return NextResponse.json(
      { error: "Insufficient role", code: ErrorCode.DASHBOARD.INSUFFICIENT_ROLE },
      { status: 403 },
    );
  }

  // Deletes the project (cascading its api keys) and queues the erasure of its
  // ClickHouse data in one transaction; the erasure worker retries until done.
  const deleted = await deleteProjectWithErasure(getDb(), auth.workspaceId, auth.projectId);

  if (!deleted) {
    return NextResponse.json(
      { error: "Project not found", code: ErrorCode.DASHBOARD.PROJECT_NOT_FOUND },
      { status: 404 },
    );
  }

  kickErasure();

  return NextResponse.json({ message: "Project deleted" });
}
