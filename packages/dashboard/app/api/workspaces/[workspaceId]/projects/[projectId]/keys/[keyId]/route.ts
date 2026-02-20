import { getServerSession } from "@/lib/auth/get-session";
import { checkWorkspaceAccess } from "@/lib/auth/workspace-access";
import { getDb } from "@/lib/db";
import { apiKeys } from "@yavio/db/schema";
import { ErrorCode } from "@yavio/shared/error-codes";
import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

type RouteContext = {
  params: Promise<{ workspaceId: string; projectId: string; keyId: string }>;
};

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

  const { workspaceId, projectId, keyId } = await routeContext.params;
  const access = await checkWorkspaceAccess(session.userId, workspaceId);
  if (!access) {
    return {
      error: NextResponse.json(
        { error: "Not a member of this workspace", code: ErrorCode.DASHBOARD.NOT_A_MEMBER },
        { status: 403 },
      ),
    };
  }

  return { session, workspaceId, projectId, keyId, access };
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

  // Find the key and check it belongs to the right project/workspace
  const [existing] = await db
    .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.id, auth.keyId),
        eq(apiKeys.projectId, auth.projectId),
        eq(apiKeys.workspaceId, auth.workspaceId),
      ),
    )
    .limit(1);

  if (!existing) {
    return NextResponse.json(
      { error: "API key not found", code: ErrorCode.DASHBOARD.API_KEY_NOT_FOUND },
      { status: 404 },
    );
  }

  if (existing.revokedAt !== null) {
    return NextResponse.json(
      { error: "API key already revoked", code: ErrorCode.DASHBOARD.API_KEY_ALREADY_REVOKED },
      { status: 409 },
    );
  }

  const [revoked] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, auth.keyId), isNull(apiKeys.revokedAt)))
    .returning({
      id: apiKeys.id,
      keyPrefix: apiKeys.keyPrefix,
      revokedAt: apiKeys.revokedAt,
    });

  return NextResponse.json({ key: revoked });
}
