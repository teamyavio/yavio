import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";
import type { ApiKeyResolver } from "./lib/api-key-resolver.js";
import type { BatchWriter } from "./lib/batch-writer.js";
import type { RateLimiter } from "./lib/rate-limiter.js";

export interface AuthContext {
  projectId: string;
  workspaceId: string;
  source: "api_key" | "jwt";
  /** Only present for JWT auth — the trace ID bound to the token. */
  traceId?: string;
  /** Only present for JWT auth — the session ID bound to the token. */
  sessionId?: string;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
    clickhouse: ClickHouseClient;
    apiKeyResolver: ApiKeyResolver;
    jwtSecret: string;
    batchWriter?: BatchWriter;
    toolRegistryWriter?: BatchWriter;
    rateLimiter?: RateLimiter;
  }

  interface FastifyRequest {
    authContext?: AuthContext;
  }
}
