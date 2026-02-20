import { generateApiKey } from "@/lib/api-key/generate";
import { rotateApiKeySchema } from "@/lib/api-key/validation";
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
  const parsed = rotateApiKeySchema.safeParse(body);
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

  // Find the existing key
  const [existing] = await db
    .select({
      id: apiKeys.id,
      projectId: apiKeys.projectId,
      workspaceId: apiKeys.workspaceId,
      name: apiKeys.name,
      revokedAt: apiKeys.revokedAt,
    })
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

  const hashSecret = process.env.API_KEY_HASH_SECRET;
  if (!hashSecret) {
    return NextResponse.json(
      { error: "Server configuration error", code: ErrorCode.DASHBOARD.INTERNAL_ERROR },
      { status: 500 },
    );
  }

  const { rawKey, keyHash, keyPrefix } = generateApiKey(hashSecret);
  const gracePeriodMinutes = parsed.data.gracePeriodMinutes;

  // Determine revocation time for the old key
  const revokedAt = gracePeriodMinutes
    ? new Date(Date.now() + gracePeriodMinutes * 60 * 1000)
    : new Date();

  const result = await db.transaction(async (tx) => {
    // Revoke old key
    await tx
      .update(apiKeys)
      .set({ revokedAt })
      .where(and(eq(apiKeys.id, auth.keyId), isNull(apiKeys.revokedAt)));

    // Create new key
    const [newKey] = await tx
      .insert(apiKeys)
      .values({
        projectId: auth.projectId,
        workspaceId: auth.workspaceId,
        keyHash,
        keyPrefix,
        name: existing.name,
      })
      .returning({
        id: apiKeys.id,
        keyPrefix: apiKeys.keyPrefix,
        name: apiKeys.name,
        createdAt: apiKeys.createdAt,
      });

    return newKey;
  });

  return NextResponse.json(
    {
      apiKey: { ...result, rawKey },
      revokedKeyId: auth.keyId,
      gracePeriodMinutes: gracePeriodMinutes ?? 0,
    },
    { status: 201 },
  );
}
