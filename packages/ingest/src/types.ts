import type { ClickHouseClient } from "@clickhouse/client";
import type { Database } from "@yavio/db/client";

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
    clickhouse: ClickHouseClient;
  }
}
