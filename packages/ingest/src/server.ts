import { LONG_RUNNING_REQUEST_TIMEOUT_MS, createClickHouseClient } from "@yavio/db/clickhouse";
import { createDb } from "@yavio/db/client";
import { loadConfig } from "./config.js";
import { createApp } from "./index.js";
import { BatchWriter } from "./lib/batch-writer.js";
import type { EnrichedEvent } from "./lib/event-enricher.js";
import { RateLimiter } from "./lib/rate-limiter.js";
import { StatsJob } from "./stats/job.js";
import { PgStatsJobStore } from "./stats/store.js";

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

  const db = createDb(config.databaseUrl);

  const app = await createApp({
    db,
    databaseUrl: config.databaseUrl,
    clickhouseUrl: config.clickhouseUrl,
    apiKeyHashSecret: config.apiKeyHashSecret,
    jwtSecret: config.jwtSecret,
    clickhouse,
    batchWriter,
    toolRegistryWriter,
    rateLimiter,
    trustProxy: config.trustProxy,
  });

  // Anonymous statistics (#85): daily, under a Postgres advisory lock.
  let statsJob: StatsJob | null = null;
  if (config.rollupClickhouseUrl) {
    statsJob = new StatsJob({
      // A month's INSERT ... SELECT over events FINAL runs for minutes on a
      // large table; with the library's 30 s default the first backfill of a
      // big month failed every day and that month was never computed.
      clickhouse: createClickHouseClient(config.rollupClickhouseUrl, {
        requestTimeoutMs: LONG_RUNNING_REQUEST_TIMEOUT_MS,
      }),
      store: new PgStatsJobStore(db),
      logger: app.log,
    });
    statsJob.start();
  } else {
    // Loud on purpose: without the job, raw events expire after 13 months and
    // nothing of them is kept.
    app.log.error(
      { variable: "CLICKHOUSE_ROLLUP_PASSWORD" },
      "Statistics job disabled: CLICKHOUSE_ROLLUP_PASSWORD is not set. Raw events expire after 13 months without anonymous statistics being kept.",
    );
  }

  app.addHook("onClose", async () => {
    statsJob?.stop();
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
