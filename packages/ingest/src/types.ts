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
    /** Set when the IP bucket was charged on arrival (plugins/rate-limit.ts). */
    ipRateCharged: boolean;
    /** The events handler charged this request's events to its key's or widget token's bucket. */
    eventsCharged: boolean;
    /** Charged to the auth-failure bucket on arrival: a header-less events request (plugins/rate-limit.ts). */
    authFailureCharged: boolean;
    /** Bytes of body the events route's parser read (0 when it read none). */
    bodyBytes: number;
  }
}
