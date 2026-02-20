import { getServerSession } from "@/lib/auth/get-session";
import { checkWorkspaceAccess } from "@/lib/auth/workspace-access";
import { getDb } from "@/lib/db";
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

  const db = getDb();

  // Delete project (cascades api keys via FK)
  const [deleted] = await db
    .delete(projects)
    .where(and(eq(projects.id, auth.projectId), eq(projects.workspaceId, auth.workspaceId)))
    .returning({ id: projects.id });

  if (!deleted) {
    return NextResponse.json(
      { error: "Project not found", code: ErrorCode.DASHBOARD.PROJECT_NOT_FOUND },
      { status: 404 },
    );
  }

  // Clean up ClickHouse data asynchronously
  try {
    const { getClickHouseClient } = await import("@/lib/clickhouse");
    const ch = getClickHouseClient();
    await ch.command({
      query: "ALTER TABLE events DELETE WHERE project_id = {id:String}",
      query_params: { id: auth.projectId },
    });
  } catch {
    // Non-fatal: ClickHouse cleanup can fail
    console.error(`Failed to clean ClickHouse data for project ${auth.projectId}`);
  }

  return NextResponse.json({ message: "Project deleted" });
}
