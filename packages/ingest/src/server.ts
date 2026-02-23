import { createClickHouseClient } from "@yavio/db/clickhouse";
import { loadConfig } from "./config.js";
import { createApp } from "./index.js";
import { BatchWriter } from "./lib/batch-writer.js";
import type { EnrichedEvent } from "./lib/event-enricher.js";
import { RateLimiter } from "./lib/rate-limiter.js";

function mapToolRegistryRow(event: EnrichedEvent): Record<string, unknown> {
  const inputSchema = event.input_schema;
  let inputSchemaStr = "{}";
  if (inputSchema !== undefined && inputSchema !== null) {
    inputSchemaStr =
      typeof inputSchema === "object" ? JSON.stringify(inputSchema) : String(inputSchema);
  }

  return {
    project_id: event.project_id,
    tool_name: String(event.tool_name ?? ""),
    description: event.description ?? null,
    input_schema: inputSchemaStr,
    registered_at: String(event.timestamp),
    updated_at: String(event.ingested_at),
  };
}

async function main() {
  const config = loadConfig();

  const clickhouse = createClickHouseClient(config.clickhouseUrl);
  const batchWriter = new BatchWriter({ clickhouse });
  batchWriter.start();

  const toolRegistryWriter = new BatchWriter({
    clickhouse,
    table: "tool_registry",
    mapRow: mapToolRegistryRow,
    flushIntervalMs: 5_000,
    flushSize: 100,
    maxBufferSize: 1_000,
  });
  toolRegistryWriter.start();

  const rateLimiter = new RateLimiter();
  rateLimiter.start();

  const app = await createApp({
    databaseUrl: config.databaseUrl,
    clickhouseUrl: config.clickhouseUrl,
    apiKeyHashSecret: config.apiKeyHashSecret,
    jwtSecret: config.jwtSecret,
    corsOrigins: config.corsOrigins,
    clickhouse,
    batchWriter,
    toolRegistryWriter,
    rateLimiter,
  });

  app.addHook("onClose", async () => {
    rateLimiter.stop();
    await batchWriter.shutdown();
    await toolRegistryWriter.shutdown();
  });

  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
  } catch (err) {
    app.log.fatal(err);
    process.exit(1);
  }
}

main();
