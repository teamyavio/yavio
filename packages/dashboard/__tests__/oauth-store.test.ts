import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the token store's state machine (mocked DB). The full
 * happy-path lifecycle additionally runs against real Postgres in the
 * scripted end-to-end verification.
 */
const db = {
  insert: vi.fn(),
  update: vi.fn(),
  select: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => db) }));

import { OAuthError } from "../lib/oauth/errors";
import {
  consumeAuthorizationCode,
  createAuthorizationCode,
  issueTokens,
  rotateRefreshToken,
  verifyAccessToken,
} from "../lib/oauth/store";
import { hashToken } from "../lib/oauth/tokens";

let insertedValues: Record<string, unknown>[];
let updateSets: Record<string, unknown>[];

function chainInsert() {
  db.insert.mockImplementation(() => ({
    values: (v: Record<string, unknown>) => {
      insertedValues.push(v);
      // awaitable AND chainable: a real Promise with the conflict method
      return Object.assign(Promise.resolve(), {
        onConflictDoNothing: () => Promise.resolve(),
      });
    },
  }));
}
function chainUpdate(returningRows: unknown[]) {
  db.update.mockImplementation(() => ({
    set: (s: Record<string, unknown>) => {
      updateSets.push(s);
      return {
        where: () => {
          const promise = Promise.resolve(returningRows);
          return Object.assign(promise, { returning: () => Promise.resolve(returningRows) });
        },
      };
    },
  }));
}
function chainSelect(rows: unknown[]) {
  db.select.mockImplementation(() => ({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  }));
}

const baseTokenRow = {
  id: "row-1",
  grantId: "grant-1",
  clientId: "yvc_client",
  userId: "user-1",
  workspaceId: "ws-1",
  scope: "analytics:read offline_access",
  audience: "https://dashboard.test/api/mcp",
  accessTokenHash: "hash",
  accessTokenExpiresAt: new Date(Date.now() + 3600_000),
  refreshTokenHash: "rhash",
  refreshTokenExpiresAt: new Date(Date.now() + 86400_000),
  rotatedAt: null as Date | null,
  revokedAt: null as Date | null,
};

describe("oauth token store", () => {
  beforeEach(() => {
    process.env.API_KEY_HASH_SECRET = "unit-secret";
    insertedValues = [];
    updateSets = [];
    vi.clearAllMocks();
    chainInsert();
  });
  afterEach(() => {
    process.env.API_KEY_HASH_SECRET = undefined;
  });

  it("stores authorization codes hashed, never raw", async () => {
    const raw = await createAuthorizationCode({
      clientId: "yvc_client",
      userId: "user-1",
      workspaceId: "ws-1",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      scope: "analytics:read",
      codeChallenge: "challenge",
      resource: null,
    });
    expect(raw).toMatch(/^yvo_ac_/);
    expect(insertedValues[0].codeHash).toBe(hashToken(raw));
    expect(JSON.stringify(insertedValues)).not.toContain(raw);
  });

  it("consume: invalid/expired/used code → invalid_grant", async () => {
    chainUpdate([]);
    await expect(consumeAuthorizationCode("yvo_ac_x")).rejects.toMatchObject({
      error: "invalid_grant",
    });
  });

  it("issueTokens: refresh token only when requested, hashes at rest", async () => {
    const withRefresh = await issueTokens({
      clientId: "yvc_client",
      userId: "user-1",
      workspaceId: "ws-1",
      scope: "analytics:read offline_access",
      audience: "aud",
      includeRefreshToken: true,
    });
    expect(withRefresh.refreshToken).toMatch(/^yvo_rt_/);
    expect(insertedValues[0].refreshTokenHash).toBe(hashToken(withRefresh.refreshToken as string));

    const withoutRefresh = await issueTokens({
      clientId: "yvc_client",
      userId: "user-1",
      workspaceId: "ws-1",
      scope: "analytics:read",
      audience: "aud",
      includeRefreshToken: false,
    });
    expect(withoutRefresh.refreshToken).toBeNull();
    expect(insertedValues[1].refreshTokenHash).toBeNull();
    expect(withRefresh.accessTokenExpiresInSeconds).toBe(3600);
  });

  it("rotate: unknown, revoked, foreign-client and expired tokens → invalid_grant", async () => {
    chainSelect([]);
    await expect(rotateRefreshToken("yvo_rt_x", "yvc_client")).rejects.toMatchObject({
      error: "invalid_grant",
    });

    chainSelect([{ ...baseTokenRow, revokedAt: new Date() }]);
    await expect(rotateRefreshToken("yvo_rt_x", "yvc_client")).rejects.toMatchObject({
      error: "invalid_grant",
    });

    chainSelect([baseTokenRow]);
    await expect(rotateRefreshToken("yvo_rt_x", "yvc_other")).rejects.toMatchObject({
      error: "invalid_grant",
    });

    chainSelect([{ ...baseTokenRow, refreshTokenExpiresAt: new Date(Date.now() - 1000) }]);
    await expect(rotateRefreshToken("yvo_rt_x", "yvc_client")).rejects.toMatchObject({
      error: "invalid_grant",
    });
  });

  it("rotate: replay beyond the grace window revokes the whole family", async () => {
    chainSelect([{ ...baseTokenRow, rotatedAt: new Date(Date.now() - 60_000) }]);
    chainUpdate([]);
    await expect(rotateRefreshToken("yvo_rt_x", "yvc_client")).rejects.toBeInstanceOf(OAuthError);
    // the family revocation is the update that set revokedAt
    expect(updateSets.some((s) => s.revokedAt instanceof Date)).toBe(true);
  });

  it("rotate: replay within the grace window issues a fresh pair (parallel-refresh race)", async () => {
    chainSelect([{ ...baseTokenRow, rotatedAt: new Date(Date.now() - 5_000) }]);
    chainUpdate([{ id: "row-1" }]);
    const result = await rotateRefreshToken("yvo_rt_x", "yvc_client");
    expect(result.accessToken).toMatch(/^yvo_at_/);
    expect(result.refreshToken).toMatch(/^yvo_rt_/);
    // no revocation happened
    expect(updateSets.some((s) => s.revokedAt instanceof Date)).toBe(false);
    // new pair stays in the same grant family
    expect(insertedValues[0].grantId).toBe("grant-1");
  });

  it("rotate: normal path claims the row and issues in the same family", async () => {
    chainSelect([baseTokenRow]);
    chainUpdate([{ id: "row-1" }]);
    const result = await rotateRefreshToken("yvo_rt_x", "yvc_client");
    expect(updateSets.some((s) => s.rotatedAt instanceof Date)).toBe(true);
    expect(insertedValues[0].grantId).toBe("grant-1");
    expect(result.workspaceId).toBe("ws-1");
    expect(result.scope).toBe("analytics:read offline_access");
  });

  it("verifyAccessToken: unknown, revoked and expired → null; valid → context", async () => {
    chainUpdate([]);
    chainSelect([]);
    expect(await verifyAccessToken("yvo_at_x")).toBeNull();

    chainSelect([{ ...baseTokenRow, revokedAt: new Date() }]);
    expect(await verifyAccessToken("yvo_at_x")).toBeNull();

    chainSelect([{ ...baseTokenRow, accessTokenExpiresAt: new Date(Date.now() - 1000) }]);
    expect(await verifyAccessToken("yvo_at_x")).toBeNull();

    chainSelect([baseTokenRow]);
    expect(await verifyAccessToken("yvo_at_x")).toEqual({
      userId: "user-1",
      workspaceId: "ws-1",
      clientId: "yvc_client",
      scope: "analytics:read offline_access",
      audience: "https://dashboard.test/api/mcp",
    });
  });
});
