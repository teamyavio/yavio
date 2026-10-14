import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import { createClickHouseClient } from "@yavio/db/clickhouse";
import { createDb } from "@yavio/db/client";
import type { Database } from "@yavio/db/client";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ApiKeyResolver } from "./lib/api-key-resolver.js";
import type { BatchWriter } from "./lib/batch-writer.js";
import type { RateLimiter } from "./lib/rate-limiter.js";
import { authPlugin } from "./plugins/auth.js";
import { corsPlugin } from "./plugins/cors.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { eventsPlugin } from "./plugins/events.js";
import { healthPlugin } from "./plugins/health.js";
import { rateLimitPlugin } from "./plugins/rate-limit.js";
import { widgetTokensPlugin } from "./plugins/widget-tokens.js";
import "./types.js";

export interface CreateAppOptions {
  /** PostgreSQL connection URL. Ignored if `db` is provided. */
  databaseUrl?: string;
  /** ClickHouse connection URL. Ignored if `clickhouse` is provided. */
  clickhouseUrl?: string;
  /** Pre-built Drizzle database instance (for testing). */
  db?: Database;
  /** Pre-built ClickHouse client instance (for testing). */
  clickhouse?: ClickHouseClient;
  /** Pre-built API key resolver (for testing). */
  apiKeyResolver?: ApiKeyResolver;
  /** HMAC secret for hashing API keys. Required unless `apiKeyResolver` is provided. */
  apiKeyHashSecret?: string;
  /** Secret for signing/verifying JWTs. */
  jwtSecret?: string;
  /** Pre-built batch writer (for testing). */
  batchWriter?: BatchWriter;
  /** Pre-built tool registry writer (for testing). */
  toolRegistryWriter?: BatchWriter;
  /** Pre-built rate limiter (for testing). */
  rateLimiter?: RateLimiter;
  /** Enable Fastify request logging. Defaults to true. */
  logger?: boolean;
  /** Where log lines go (for testing). Defaults to stdout. */
  logStream?: { write(line: string): void };
  /**
   * Proxy addresses (IP or CIDR) whose X-Forwarded-For is trusted (#94).
   * Empty or absent: request.ip is the socket peer.
   */
  trustProxy?: string[];
}

/**
 * What a request log line may contain (#92): method and route, nothing that
 * identifies the client. Fastify's default serializer adds the client IP, port,
 * host and the full URL — whose query string is where widget beacons carried
 * their token (#96). Status code and response time are logged by the default
 * `res` serializer and Fastify's completion line.
 */
export const requestLogSerializers = {
  req(request: FastifyRequest) {
    return {
      method: request.method,
      // The matched route pattern (/v1/events); for unknown routes the path.
      url: request.routeOptions?.url ?? request.url.split("?")[0],
    };
  },
};

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            serializers: requestLogSerializers,
            ...(options.logStream ? { stream: options.logStream } : {}),
          },
    genReqId: () => randomUUID(),
    trustProxy: options.trustProxy && options.trustProxy.length > 0 ? options.trustProxy : false,
  });

  const db = options.db ?? createDb(options.databaseUrl as string);
  const clickhouse = options.clickhouse ?? createClickHouseClient(options.clickhouseUrl as string);
  const apiKeyResolver =
    options.apiKeyResolver ?? new ApiKeyResolver(db, options.apiKeyHashSecret as string);
  const jwtSecret = options.jwtSecret;
  if (!jwtSecret) {
    throw new Error("jwtSecret is required");
  }

  app.decorate("db", db);
  app.decorate("clickhouse", clickhouse);
  app.decorate("apiKeyResolver", apiKeyResolver);
  app.decorate("jwtSecret", jwtSecret);

  if (options.batchWriter) {
    app.decorate("batchWriter", options.batchWriter);
  }

  if (options.toolRegistryWriter) {
    app.decorate("toolRegistryWriter", options.toolRegistryWriter);
  }

  if (options.rateLimiter) {
    app.decorate("rateLimiter", options.rateLimiter);
  }

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  await app.register(errorHandlerPlugin);
  await app.register(corsPlugin);
  await app.register(rateLimitPlugin);
  await app.register(authPlugin);
  await app.register(healthPlugin);
  await app.register(widgetTokensPlugin, { jwtSecret });
  await app.register(eventsPlugin);

  return app;
}
