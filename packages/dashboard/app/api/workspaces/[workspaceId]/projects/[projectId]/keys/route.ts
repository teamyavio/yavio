import { generateApiKey } from "@/lib/api-key/generate";
import { createApiKeySchema } from "@/lib/api-key/validation";
import { getServerSession } from "@/lib/auth/get-session";
import { checkWorkspaceAccess } from "@/lib/auth/workspace-access";
import { getDb } from "@/lib/db";
import { apiKeys, projects } from "@yavio/db/schema";
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

export async function POST(request: Request, routeContext: RouteContext) {
  const auth = await authenticate(routeContext);
  if ("error" in auth) return auth.error;

  if (auth.access.role === "viewer") {
    return NextResponse.json(
      { error: "Insufficient role", code: ErrorCode.DASHBOARD.INSUFFICIENT_ROLE },
      { status: 403 },
    );
  }

  const body = await request.json();
  const parsed = createApiKeySchema.safeParse(body);
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

  // Verify project exists in workspace
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, auth.projectId), eq(projects.workspaceId, auth.workspaceId)))
    .limit(1);

  if (!project) {
    return NextResponse.json(
      { error: "Project not found", code: ErrorCode.DASHBOARD.PROJECT_NOT_FOUND },
      { status: 404 },
    );
  }

  const hashSecret = process.env.API_KEY_HASH_SECRET;
  if (!hashSecret) {
    return NextResponse.json(
      { error: "Server configuration error", code: ErrorCode.DASHBOARD.INTERNAL_ERROR },
      { status: 500 },
    );
  }

  const { rawKey, keyHash, keyPrefix } = generateApiKey(hashSecret);

  const [apiKey] = await db
    .insert(apiKeys)
    .values({
      projectId: auth.projectId,
      workspaceId: auth.workspaceId,
      keyHash,
      keyPrefix,
      name: parsed.data.name ?? "Default",
    })
    .returning({
      id: apiKeys.id,
      keyPrefix: apiKeys.keyPrefix,
      name: apiKeys.name,
      createdAt: apiKeys.createdAt,
    });

  return NextResponse.json({ apiKey: { ...apiKey, rawKey } }, { status: 201 });
}

export async function GET(_request: Request, routeContext: RouteContext) {
  const auth = await authenticate(routeContext);
  if ("error" in auth) return auth.error;

  const db = getDb();

  // Verify project exists in workspace
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, auth.projectId), eq(projects.workspaceId, auth.workspaceId)))
    .limit(1);

  if (!project) {
    return NextResponse.json(
      { error: "Project not found", code: ErrorCode.DASHBOARD.PROJECT_NOT_FOUND },
      { status: 404 },
    );
  }

  const rows = await db
    .select({
      id: apiKeys.id,
      keyPrefix: apiKeys.keyPrefix,
      name: apiKeys.name,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.projectId, auth.projectId), eq(apiKeys.workspaceId, auth.workspaceId)));

  return NextResponse.json({ keys: rows });
}
