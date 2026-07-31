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
  revokeToken,
  rotateRefreshToken,
  verifyAccessToken,
} from "../lib/oauth/store";
import { deriveSuccessorTokens, hashToken } from "../lib/oauth/tokens";

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
/** Successive UPDATEs return successive entries (last one repeats). */
function chainUpdateQueue(queue: unknown[][]) {
  let i = 0;
  db.update.mockImplementation(() => ({
    set: (setValues: Record<string, unknown>) => {
      updateSets.push(setValues);
      const rows = queue[Math.min(i++, queue.length - 1)];
      return {
        where: () =>
          Object.assign(Promise.resolve(rows), { returning: () => Promise.resolve(rows) }),
      };
    },
  }));
}
function chainSelect(rows: unknown[]) {
  db.select.mockImplementation(() => ({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  }));
}
/** Successive SELECTs return successive entries (last one repeats). */
function chainSelectQueue(queue: unknown[][]) {
  let i = 0;
  db.select.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(queue[Math.min(i++, queue.length - 1)]),
      }),
    }),
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
  graceUsedAt: null as Date | null,
  rotationNonce: null as string | null,
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
    delete process.env.API_KEY_HASH_SECRET;
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
    chainSelect([
      { ...baseTokenRow, rotatedAt: new Date(Date.now() - 60_000), rotationNonce: "n" },
    ]);
    chainUpdate([]);
    await expect(rotateRefreshToken("yvo_rt_x", "yvc_client")).rejects.toBeInstanceOf(OAuthError);
    expect(updateSets.some((s) => s.revokedAt instanceof Date)).toBe(true);
  });

  it("rotate: a concurrent duplicate returns the SAME pair the winner got — no second chain", async () => {
    const nonce = "fixed-nonce";
    const winner = deriveSuccessorTokens("yvo_rt_x", nonce);
    chainSelectQueue([
      // 1) the presented (already rotated) row
      [{ ...baseTokenRow, rotatedAt: new Date(Date.now() - 5_000), rotationNonce: nonce }],
      // 2) the successor row the winner inserted — still live
      [{ expiresAt: new Date(Date.now() + 3_500_000), revokedAt: null }],
    ]);
    chainUpdate([{ id: "row-1" }]);

    const result = await rotateRefreshToken("yvo_rt_x", "yvc_client");

    expect(result.accessToken).toBe(winner.accessToken);
    expect(result.refreshToken).toBe(winner.refreshToken);
    // nothing new inserted — a second chain is what made replay undetectable
    expect(insertedValues).toHaveLength(0);
    expect(updateSets.some((s) => s.revokedAt instanceof Date)).toBe(false);
  });

  it("rotate: a rotated row with no recorded nonce is treated as replay", async () => {
    chainSelect([
      { ...baseTokenRow, rotatedAt: new Date(Date.now() - 5_000), rotationNonce: null },
    ]);
    chainUpdate([]);
    await expect(rotateRefreshToken("yvo_rt_x", "yvc_client")).rejects.toMatchObject({
      error: "invalid_grant",
    });
    expect(updateSets.some((s) => s.revokedAt instanceof Date)).toBe(true);
  });

  it("rotate: a duplicate whose successor was already revoked revokes the family", async () => {
    const nonce = "fixed-nonce";
    chainSelectQueue([
      [{ ...baseTokenRow, rotatedAt: new Date(Date.now() - 5_000), rotationNonce: nonce }],
      [{ expiresAt: new Date(Date.now() + 1000), revokedAt: new Date() }],
    ]);
    chainUpdate([]);
    await expect(rotateRefreshToken("yvo_rt_x", "yvc_client")).rejects.toMatchObject({
      error: "invalid_grant",
    });
    expect(updateSets.some((s) => s.revokedAt instanceof Date)).toBe(true);
  });

  it("rotate: losing the rotation claim replays the winner instead of forking", async () => {
    const nonce = "winner-nonce";
    const winner = deriveSuccessorTokens("yvo_rt_x", nonce);
    chainSelectQueue([
      [baseTokenRow], // looked pristine when we read it
      [{ rotationNonce: nonce }], // re-read after losing the claim
      [{ expiresAt: new Date(Date.now() + 3_500_000), revokedAt: null }],
    ]);
    // 1st UPDATE = the rotation claim we lose; 2nd = the grace claim we win
    chainUpdateQueue([[], [{ id: "row-1" }]]);
    const result = await rotateRefreshToken("yvo_rt_x", "yvc_client");
    expect(result.refreshToken).toBe(winner.refreshToken);
    expect(insertedValues).toHaveLength(0);
    expect(updateSets.some((s) => s.revokedAt instanceof Date)).toBe(false);
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

  it("revokeToken: revokes the whole family, and is a silent no-op for unknown tokens", async () => {
    chainUpdate([]);
    chainSelect([]);
    await expect(revokeToken("yvo_rt_unknown")).resolves.toBeUndefined();
    expect(updateSets).toHaveLength(0);

    chainSelect([{ grantId: "grant-1" }]);
    await revokeToken("yvo_rt_known");
    expect(updateSets.some((s) => s.revokedAt instanceof Date)).toBe(true);
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

describe("rotation grace window is single-use", () => {
  beforeEach(() => {
    process.env.API_KEY_HASH_SECRET = "unit-secret";
    insertedValues = [];
    updateSets = [];
    vi.clearAllMocks();
    chainInsert();
  });

  it("a SECOND replay of an already-replayed token revokes the family", async () => {
    const nonce = "n";
    chainSelectQueue([
      [{ ...baseTokenRow, rotatedAt: new Date(Date.now() - 5_000), rotationNonce: nonce }],
      [{ expiresAt: new Date(Date.now() + 3_500_000), revokedAt: null }],
    ]);
    // the graceUsedAt claim wins nothing => this row was already replayed
    chainUpdate([]);
    await expect(rotateRefreshToken("yvo_rt_x", "yvc_client")).rejects.toMatchObject({
      error: "invalid_grant",
    });
    expect(updateSets.some((s) => s.revokedAt instanceof Date)).toBe(true);
  });

  it("a row already marked graceUsedAt is replay on sight", async () => {
    chainSelectQueue([
      [
        {
          ...baseTokenRow,
          rotatedAt: new Date(Date.now() - 5_000),
          rotationNonce: "n",
          graceUsedAt: new Date(),
        },
      ],
    ]);
    chainUpdate([]);
    await expect(rotateRefreshToken("yvo_rt_x", "yvc_client")).rejects.toMatchObject({
      error: "invalid_grant",
    });
    expect(updateSets.some((s) => s.revokedAt instanceof Date)).toBe(true);
  });
});
