import { createHmac } from "node:crypto";
import type { Database } from "@yavio/db/client";
import { apiKeys } from "@yavio/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { LruCache } from "./lru-cache.js";

export interface ResolvedKey {
  projectId: string;
  workspaceId: string;
}

const CACHE_TTL_MS = 60_000; // 60 seconds
const CACHE_MAX_SIZE = 10_000;

export class ApiKeyResolver {
  private readonly cache: LruCache<ResolvedKey | null>;

  constructor(
    private readonly db: Database,
    private readonly hashSecret: string,
  ) {
    this.cache = new LruCache(CACHE_MAX_SIZE, CACHE_TTL_MS);
  }

  /** Hash a raw API key to match the stored `key_hash` column. */
  hashKey(rawKey: string): string {
    return createHmac("sha256", this.hashSecret).update(rawKey).digest("hex");
  }

  /**
   * Resolve a raw API key to its project/workspace.
   * Returns `null` if the key is invalid or revoked.
   */
  async resolve(rawKey: string): Promise<ResolvedKey | null> {
    const hash = this.hashKey(rawKey);

    const cached = this.cache.get(hash);
    if (cached !== undefined) return cached;

    const rows = await this.db
      .select({
        projectId: apiKeys.projectId,
        workspaceId: apiKeys.workspaceId,
        id: apiKeys.id,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
      .limit(1);

    if (rows.length === 0) {
      this.cache.set(hash, null);
      return null;
    }

    const result: ResolvedKey = {
      projectId: rows[0].projectId,
      workspaceId: rows[0].workspaceId,
    };

    this.cache.set(hash, result);

    // Fire-and-forget lastUsedAt update
    this.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, rows[0].id))
      .then(() => {})
      .catch(() => {});

    return result;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
