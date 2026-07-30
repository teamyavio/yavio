import crypto from "node:crypto";
import { getDb } from "@/lib/db";
import { oauthCodes, oauthTokens } from "@yavio/db/schema";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import {
  ACCESS_TOKEN_TTL_MS,
  AUTH_CODE_TTL_MS,
  REFRESH_ROTATION_GRACE_MS,
  REFRESH_TOKEN_TTL_MS,
} from "./constants";
import { OAuthError } from "./errors";
import { generateToken, hashToken } from "./tokens";

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresInSeconds: number;
  refreshToken: string | null;
}

export interface CodeGrantParams {
  clientId: string;
  userId: string;
  workspaceId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  resource: string | null;
}

export async function createAuthorizationCode(params: CodeGrantParams): Promise<string> {
  const rawCode = generateToken("ac");
  await getDb()
    .insert(oauthCodes)
    .values({
      codeHash: hashToken(rawCode),
      clientId: params.clientId,
      userId: params.userId,
      workspaceId: params.workspaceId,
      redirectUri: params.redirectUri,
      scope: params.scope,
      codeChallenge: params.codeChallenge,
      resource: params.resource,
      expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
    });
  return rawCode;
}

export interface ConsumedCode {
  clientId: string;
  userId: string;
  workspaceId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  resource: string | null;
}

/**
 * Atomic single-use claim: the UPDATE only wins for one caller, so a replayed
 * code fails no matter how tight the race.
 */
export async function consumeAuthorizationCode(rawCode: string): Promise<ConsumedCode> {
  const rows = await getDb()
    .update(oauthCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(oauthCodes.codeHash, hashToken(rawCode)),
        isNull(oauthCodes.usedAt),
        gt(oauthCodes.expiresAt, new Date()),
      ),
    )
    .returning();

  if (rows.length === 0) {
    throw new OAuthError(
      "invalid_grant",
      "authorization code is invalid, expired, or already used",
      400,
    );
  }
  const row = rows[0];
  return {
    clientId: row.clientId,
    userId: row.userId,
    workspaceId: row.workspaceId,
    redirectUri: row.redirectUri,
    scope: row.scope,
    codeChallenge: row.codeChallenge,
    resource: row.resource,
  };
}

interface IssueParams {
  grantId?: string;
  clientId: string;
  userId: string;
  workspaceId: string;
  scope: string;
  audience: string;
  includeRefreshToken: boolean;
}

export async function issueTokens(params: IssueParams): Promise<IssuedTokens> {
  const accessToken = generateToken("at");
  const refreshToken = params.includeRefreshToken ? generateToken("rt") : null;
  const now = Date.now();

  await getDb()
    .insert(oauthTokens)
    .values({
      grantId: params.grantId ?? crypto.randomUUID(),
      clientId: params.clientId,
      userId: params.userId,
      workspaceId: params.workspaceId,
      scope: params.scope,
      audience: params.audience,
      accessTokenHash: hashToken(accessToken),
      accessTokenExpiresAt: new Date(now + ACCESS_TOKEN_TTL_MS),
      refreshTokenHash: refreshToken ? hashToken(refreshToken) : null,
      refreshTokenExpiresAt: refreshToken ? new Date(now + REFRESH_TOKEN_TTL_MS) : null,
    });

  return {
    accessToken,
    accessTokenExpiresInSeconds: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refreshToken,
  };
}

async function revokeGrantFamily(grantId: string): Promise<void> {
  await getDb()
    .update(oauthTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(oauthTokens.grantId, grantId), isNull(oauthTokens.revokedAt)));
}

/**
 * Refresh-token rotation with reuse detection:
 * - normal path: atomically mark the row rotated, issue a fresh pair in the
 *   same grant family;
 * - a rotated-out token re-presented within the grace window is a benign
 *   parallel-refresh race and gets its own fresh pair;
 * - beyond the grace window it is replay: the whole family is revoked.
 *
 * Dead tokens answer with RFC 6749 `invalid_grant` verbatim — Claude keys its
 * re-auth flow off that exact code.
 */
export async function rotateRefreshToken(
  rawRefreshToken: string,
  clientId: string,
): Promise<
  IssuedTokens & { workspaceId: string; userId: string; scope: string; audience: string }
> {
  const db = getDb();
  const rows = await db
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.refreshTokenHash, hashToken(rawRefreshToken)))
    .limit(1);

  if (rows.length === 0) {
    throw new OAuthError("invalid_grant", "refresh token is invalid", 400);
  }
  const row = rows[0];

  if (row.revokedAt !== null) {
    throw new OAuthError("invalid_grant", "refresh token has been revoked", 400);
  }
  if (row.clientId !== clientId) {
    throw new OAuthError("invalid_grant", "refresh token was issued to a different client", 400);
  }
  if (row.refreshTokenExpiresAt === null || row.refreshTokenExpiresAt.getTime() <= Date.now()) {
    throw new OAuthError("invalid_grant", "refresh token has expired", 400);
  }

  if (row.rotatedAt !== null) {
    const sinceRotation = Date.now() - row.rotatedAt.getTime();
    if (sinceRotation > REFRESH_ROTATION_GRACE_MS) {
      await revokeGrantFamily(row.grantId);
      throw new OAuthError("invalid_grant", "refresh token has been revoked", 400);
    }
    // Benign race: a parallel refresh already rotated this token.
  } else {
    const claimed = await db
      .update(oauthTokens)
      .set({ rotatedAt: new Date(), lastUsedAt: new Date() })
      .where(and(eq(oauthTokens.id, row.id), isNull(oauthTokens.rotatedAt)))
      .returning({ id: oauthTokens.id });
    // Losing the claim means a parallel request rotated between our SELECT and
    // UPDATE — same benign race, fall through and issue a pair anyway.
    void claimed;
  }

  const issued = await issueTokens({
    grantId: row.grantId,
    clientId: row.clientId,
    userId: row.userId,
    workspaceId: row.workspaceId,
    scope: row.scope,
    audience: row.audience,
    includeRefreshToken: true,
  });

  return {
    ...issued,
    workspaceId: row.workspaceId,
    userId: row.userId,
    scope: row.scope,
    audience: row.audience,
  };
}

export interface VerifiedAccessToken {
  userId: string;
  workspaceId: string;
  clientId: string;
  scope: string;
  audience: string;
}

/** Access-token check for the resource server. Returns null on any failure. */
export async function verifyAccessToken(rawToken: string): Promise<VerifiedAccessToken | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.accessTokenHash, hashToken(rawToken)))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.revokedAt !== null) return null;
  if (row.accessTokenExpiresAt.getTime() <= Date.now()) return null;

  // Fire-and-forget usage stamp; token validity never depends on it.
  db.update(oauthTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(oauthTokens.id, row.id))
    .then(
      () => {},
      () => {},
    );

  return {
    userId: row.userId,
    workspaceId: row.workspaceId,
    clientId: row.clientId,
    scope: row.scope,
    audience: row.audience,
  };
}

/** Expired-row cleanup, callable from a cron later; safe to skip in v1. */
export async function pruneExpired(): Promise<void> {
  const db = getDb();
  await db.delete(oauthCodes).where(sql`expires_at < now() - interval '1 day'`);
  await db
    .delete(oauthTokens)
    .where(
      sql`access_token_expires_at < now() - interval '35 days' AND (refresh_token_expires_at IS NULL OR refresh_token_expires_at < now() - interval '5 days')`,
    );
}
