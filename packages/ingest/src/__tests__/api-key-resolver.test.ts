import { createHmac } from "node:crypto";
import type { Database } from "@yavio/db/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeyResolver } from "../lib/api-key-resolver.js";

const TEST_SECRET = "test-hash-secret";
const TEST_KEY = "yav_abc123def456abc123def456abc123de";
const TEST_PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const TEST_WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";
const TEST_KEY_ID = "33333333-3333-3333-3333-333333333333";

function expectedHash(key: string): string {
  return createHmac("sha256", TEST_SECRET).update(key).digest("hex");
}

function mockDb(rows: Record<string, unknown>[] = []): Database {
  const selectResult = {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };

  const updateResult = {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  };

  return {
    select: vi.fn().mockReturnValue(selectResult),
    update: vi.fn().mockReturnValue(updateResult),
  } as unknown as Database;
}

describe("ApiKeyResolver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hashes keys with HMAC-SHA256", () => {
    const db = mockDb();
    const resolver = new ApiKeyResolver(db, TEST_SECRET);
    expect(resolver.hashKey(TEST_KEY)).toBe(expectedHash(TEST_KEY));
  });

  it("resolves a valid API key from the database", async () => {
    const db = mockDb([
      { projectId: TEST_PROJECT_ID, workspaceId: TEST_WORKSPACE_ID, id: TEST_KEY_ID },
    ]);
    const resolver = new ApiKeyResolver(db, TEST_SECRET);

    const result = await resolver.resolve(TEST_KEY);
    expect(result).toEqual({
      projectId: TEST_PROJECT_ID,
      workspaceId: TEST_WORKSPACE_ID,
    });
  });

  it("returns null for unknown keys", async () => {
    const db = mockDb([]);
    const resolver = new ApiKeyResolver(db, TEST_SECRET);

    const result = await resolver.resolve(TEST_KEY);
    expect(result).toBeNull();
  });

  it("caches resolved keys", async () => {
    const db = mockDb([
      { projectId: TEST_PROJECT_ID, workspaceId: TEST_WORKSPACE_ID, id: TEST_KEY_ID },
    ]);
    const resolver = new ApiKeyResolver(db, TEST_SECRET);

    await resolver.resolve(TEST_KEY);
    await resolver.resolve(TEST_KEY);

    // db.select should only have been called once
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("caches null results (negative cache)", async () => {
    const db = mockDb([]);
    const resolver = new ApiKeyResolver(db, TEST_SECRET);

    await resolver.resolve(TEST_KEY);
    await resolver.resolve(TEST_KEY);

    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("cache expires after TTL", async () => {
    const db = mockDb([
      { projectId: TEST_PROJECT_ID, workspaceId: TEST_WORKSPACE_ID, id: TEST_KEY_ID },
    ]);
    const resolver = new ApiKeyResolver(db, TEST_SECRET);

    await resolver.resolve(TEST_KEY);

    // Advance past TTL (60s)
    vi.advanceTimersByTime(61_000);

    await resolver.resolve(TEST_KEY);
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("fires-and-forgets lastUsedAt update", async () => {
    const db = mockDb([
      { projectId: TEST_PROJECT_ID, workspaceId: TEST_WORKSPACE_ID, id: TEST_KEY_ID },
    ]);
    const resolver = new ApiKeyResolver(db, TEST_SECRET);

    await resolver.resolve(TEST_KEY);
    expect(db.update).toHaveBeenCalled();
  });

  it("clearCache empties the cache", async () => {
    const db = mockDb([
      { projectId: TEST_PROJECT_ID, workspaceId: TEST_WORKSPACE_ID, id: TEST_KEY_ID },
    ]);
    const resolver = new ApiKeyResolver(db, TEST_SECRET);

    await resolver.resolve(TEST_KEY);
    resolver.clearCache();
    await resolver.resolve(TEST_KEY);

    expect(db.select).toHaveBeenCalledTimes(2);
  });
});
