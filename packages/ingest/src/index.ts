import type { ClickHouseClient } from "@clickhouse/client";
import { createClickHouseClient } from "@yavio/db/clickhouse";
import { createDb } from "@yavio/db/client";
import type { Database } from "@yavio/db/client";
import Fastify, { type FastifyInstance } from "fastify";
import { corsPlugin } from "./plugins/cors.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { healthPlugin } from "./plugins/health.js";
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
  /** Enable Fastify request logging. Defaults to true. */
  logger?: boolean;
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
  });

  const db = options.db ?? createDb(options.databaseUrl as string);
  const clickhouse = options.clickhouse ?? createClickHouseClient(options.clickhouseUrl as string);

  app.decorate("db", db);
  app.decorate("clickhouse", clickhouse);

  await app.register(errorHandlerPlugin);
  await app.register(corsPlugin);
  await app.register(healthPlugin);

  return app;
}
