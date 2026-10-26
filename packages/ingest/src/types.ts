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
    /** The events route charged this request to its key's or widget token's buckets. */
    eventsCharged: boolean;
    /** Charged to the beacon bucket on arrival: a header-less events request (plugins/rate-limit.ts). */
    beaconCharged: boolean;
    /** Refused by an address bucket on arrival (plugins/rate-limit.ts). */
    arrivalRefused: boolean;
    /** Bytes of body the events route's parser read (0 when it read none). */
    bodyBytes: number;
    /**
     * Units charged on arrival, before the body was read: 1 event for an API
     * key, the declared body size for a widget token (plugins/events.ts).
     */
    reservedUnits: number;
    /** The arrival charge was settled to the request's real charge (plugins/charge.ts). */
    chargeSettled: boolean;
    /** The socket's bytesRead at the arrival charge; -1 without a socket count. */
    bytesAtArrival: number;
  }
}
