import crypto from "node:crypto";
import { getDb } from "@/lib/db";
import { oauthClients, oauthCodes, oauthTokens } from "@yavio/db/schema";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import {
  ACCESS_TOKEN_TTL_MS,
  AUTH_CODE_TTL_MS,
  REFRESH_ROTATION_GRACE_MS,
  REFRESH_TOKEN_TTL_MS,
} from "./constants";
import { OAuthError } from "./errors";
import { deriveSuccessorTokens, generateRotationNonce, generateToken, hashToken } from "./tokens";

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
  /**
   * Pre-derived pair, supplied by rotation so a concurrent duplicate refresh
   * can reproduce it exactly. Omitted for a fresh grant, which is random.
   */
  tokens?: { accessToken: string; refreshToken: string };
}

export async function issueTokens(params: IssueParams): Promise<IssuedTokens> {
  const accessToken = params.tokens?.accessToken ?? generateToken("at");
  const refreshToken = params.includeRefreshToken
    ? (params.tokens?.refreshToken ?? generateToken("rt"))
    : null;
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
 * Refresh-token rotation with reuse detection.
 *
 * Rotation is IDEMPOTENT inside the grace window: the successor pair is
 * derived from (presented token, a nonce chosen by the winning rotation), so
 * a concurrent duplicate refresh — which Claude and ChatGPT both do — is
 * answered with exactly the pair the winner received.
 *
 * That property is the whole point. An earlier design minted a *second* pair
 * for the loser, which silently forked the grant into two independently
 * rotating chains: neither ever re-presented a stale token again, so reuse
 * detection could never fire and a stolen refresh token turned into
 * permanent, undetectable access. One chain per grant keeps replay visible.
 *
 * Beyond the grace window a rotated-out token is replay: the whole family is
 * revoked. Dead tokens answer with RFC 6749 `invalid_grant` verbatim, which
 * is the code Claude keys its re-authorization flow off.
 */
export async function rotateRefreshToken(
  rawRefreshToken: string,
  clientId: string,
): Promise<
  IssuedTokens & { workspaceId: string; userId: string; scope: string; audience: string }
> {
  const db = getDb();
  const presentedHash = hashToken(rawRefreshToken);
  const rows = await db
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.refreshTokenHash, presentedHash))
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

  /**
   * Re-derive and return the successor of an already-rotated row. Because the
   * pair is a deterministic function of (presented token, stored nonce), the
   * loser of a concurrent refresh gets exactly what the winner got — one
   * chain, so a later replay of this token is still detectable.
   */
  const replayWinningRotation = async (nonce: string): Promise<IssuedTokens> => {
    const successor = deriveSuccessorTokens(rawRefreshToken, nonce);
    const successorHash = hashToken(successor.accessToken);

    // The winner marks the row rotated and THEN inserts the successor, so a
    // truly concurrent loser can arrive in between and find nothing. Treating
    // that as replay would revoke the grant in exactly the case this design
    // exists to serve, so wait briefly for the insert to land.
    let successorRow: { expiresAt: Date; revokedAt: Date | null } | undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      const rows = await db
        .select({ expiresAt: oauthTokens.accessTokenExpiresAt, revokedAt: oauthTokens.revokedAt })
        .from(oauthTokens)
        .where(eq(oauthTokens.accessTokenHash, successorHash))
        .limit(1);
      if (rows.length > 0) {
        successorRow = rows[0];
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (!successorRow || successorRow.revokedAt !== null) {
      await revokeGrantFamily(row.grantId);
      throw new OAuthError("invalid_grant", "refresh token has been revoked", 400);
    }

    // Replays INSIDE the window are allowed without limit. Capping them at one
    // looked stricter but broke the case this exists for: a client firing
    // three parallel refreshes (or retrying a timed-out one) had its grant
    // revoked and the user thrown back into the browser consent flow. Since
    // every replay returns the winner's identical pair and creates no new
    // chain, a second replay grants an attacker nothing they did not already
    // have — the detection that matters is use of a token AFTER the window,
    // which still revokes the family.
    //
    // graceUsedAt records the first replay so concurrent-refresh behaviour is
    // visible in the data rather than only in logs.
    await db
      .update(oauthTokens)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(oauthTokens.id, row.id), isNull(oauthTokens.graceUsedAt)))
      .returning({ id: oauthTokens.id });
    await db
      .update(oauthTokens)
      .set({ graceUsedAt: new Date() })
      .where(and(eq(oauthTokens.id, row.id), isNull(oauthTokens.graceUsedAt)));

    const remainingMs = successorRow.expiresAt.getTime() - Date.now();
    return {
      accessToken: successor.accessToken,
      accessTokenExpiresInSeconds: Math.max(1, Math.floor(remainingMs / 1000)),
      refreshToken: successor.refreshToken,
    };
  };

  if (row.rotatedAt !== null) {
    const sinceRotation = Date.now() - row.rotatedAt.getTime();
    if (sinceRotation > REFRESH_ROTATION_GRACE_MS || row.rotationNonce === null) {
      await revokeGrantFamily(row.grantId);
      throw new OAuthError("invalid_grant", "refresh token has been revoked", 400);
    }
    console.warn(
      `[oauth] concurrent refresh on grant ${row.grantId} (client ${row.clientId}) — replaying the winning rotation`,
    );
    const replayed = await replayWinningRotation(row.rotationNonce);
    return {
      ...replayed,
      workspaceId: row.workspaceId,
      userId: row.userId,
      scope: row.scope,
      audience: row.audience,
    };
  }

  // Claim the rotation. The nonce is written in the same conditional UPDATE,
  // so exactly one caller ever chooses it.
  const nonce = generateRotationNonce();
  const claimed = await db
    .update(oauthTokens)
    .set({ rotatedAt: new Date(), lastUsedAt: new Date(), rotationNonce: nonce })
    .where(and(eq(oauthTokens.id, row.id), isNull(oauthTokens.rotatedAt)))
    .returning({ nonce: oauthTokens.rotationNonce });

  if (claimed.length === 0) {
    // Lost the race between our SELECT and UPDATE: re-read the winner's nonce
    // and hand back the same successor.
    const fresh = await db
      .select({ rotationNonce: oauthTokens.rotationNonce })
      .from(oauthTokens)
      .where(eq(oauthTokens.id, row.id))
      .limit(1);
    if (fresh.length === 0 || fresh[0].rotationNonce === null) {
      await revokeGrantFamily(row.grantId);
      throw new OAuthError("invalid_grant", "refresh token has been revoked", 400);
    }
    const replayed = await replayWinningRotation(fresh[0].rotationNonce);
    return {
      ...replayed,
      workspaceId: row.workspaceId,
      userId: row.userId,
      scope: row.scope,
      audience: row.audience,
    };
  }

  const successor = deriveSuccessorTokens(rawRefreshToken, nonce);
  const issued = await issueTokens({
    grantId: row.grantId,
    clientId: row.clientId,
    userId: row.userId,
    workspaceId: row.workspaceId,
    scope: row.scope,
    audience: row.audience,
    includeRefreshToken: true,
    tokens: successor,
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

/**
 * RFC 7009 revocation: presenting either token of a grant revokes the whole
 * family (public clients — access and refresh belong to one authorization).
 * Unknown tokens are a silent no-op per spec.
 */
export async function revokeToken(rawToken: string): Promise<void> {
  const hash = hashToken(rawToken);
  const rows = await getDb()
    .select({ grantId: oauthTokens.grantId })
    .from(oauthTokens)
    .where(or(eq(oauthTokens.refreshTokenHash, hash), eq(oauthTokens.accessTokenHash, hash)))
    .limit(1);
  if (rows.length === 0) return;
  await revokeGrantFamily(rows[0].grantId);
}

/** Expired-row cleanup, called opportunistically from the token endpoint. */
export async function pruneExpired(): Promise<void> {
  const db = getDb();
  await db.delete(oauthCodes).where(sql`expires_at < now() - interval '1 day'`);
  await db
    .delete(oauthTokens)
    .where(
      sql`access_token_expires_at < now() - interval '35 days' AND (refresh_token_expires_at IS NULL OR refresh_token_expires_at < now() - interval '5 days')`,
    );
  // DCR registration is unauthenticated by design, so oauth_clients grows one
  // row per call and nothing reclaimed it. Drop registrations that never led
  // to a grant and are older than a refresh lifetime; CIMD clients re-register
  // themselves from their metadata document on next use.
  await db.delete(oauthClients).where(
    sql`created_at < now() - interval '35 days'
        AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.client_id = oauth_clients.client_id)
        AND NOT EXISTS (SELECT 1 FROM oauth_codes c WHERE c.client_id = oauth_clients.client_id)`,
  );
}
