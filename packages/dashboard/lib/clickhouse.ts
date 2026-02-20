import { createClickHouseClient } from "@yavio/db/clickhouse";

type ClickHouseClient = ReturnType<typeof createClickHouseClient>;

let client: ClickHouseClient | null = null;

export function getClickHouseClient(): ClickHouseClient {
  if (!client) {
    client = createClickHouseClient(process.env.CLICKHOUSE_URL);
  }
  return client;
}
