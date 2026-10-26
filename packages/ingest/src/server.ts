import type { ClickHouseClient } from "@clickhouse/client";
import { LONG_RUNNING_REQUEST_TIMEOUT_MS, createClickHouseClient } from "@yavio/db/clickhouse";
import { createDb } from "@yavio/db/client";
import type { FastifyBaseLogger } from "fastify";
import { loadConfig } from "./config.js";
import { createApp } from "./index.js";
import { BatchWriter } from "./lib/batch-writer.js";
import { RateLimiter } from "./lib/rate-limiter.js";
import {
  SKIP_SCHEMA_CHECK_VARIABLE,
  columnProblems,
  describeProblems,
} from "./lib/schema-guard.js";
import { mapToolRegistryRow } from "./lib/tool-registry.js";
import { deferredWriterLogger } from "./lib/writer-logger.js";
import { StatsJob } from "./stats/job.js";
import { PgStatsJobStore } from "./stats/store.js";

/**
 * On SIGTERM or SIGINT the writers get this long to write what they hold;
 * the process exits at SHUTDOWN_EXIT_MS at the latest. Both stay below the
 * container's stop_grace_period (docker-compose.yml, 20 s), after which
 * Docker kills the process.
 */
const WRITER_SHUTDOWN_MS = 12_000;
const SHUTDOWN_EXIT_MS = 15_000;

/** How long startup waits for ClickHouse to answer the schema check. */
const SCHEMA_CHECK_ATTEMPTS = 10;
const SCHEMA_CHECK_INTERVAL_MS = 3_000;

/**
 * Stop at startup when a column ingest writes is missing or has another type
 * (schema-guard.ts): the ClickHouse migrations were not applied, or not the
 * ones this ingest expects. INGEST_SKIP_SCHEMA_CHECK=1 skips the check, for
 * an emergency only.
 */
async function checkSchema(clickhouse: ClickHouseClient, log: FastifyBaseLogger): Promise<void> {
  if (process.env[SKIP_SCHEMA_CHECK_VARIABLE] === "1") {
    log.warn(
      { variable: SKIP_SCHEMA_CHECK_VARIABLE },
      "ClickHouse schema check skipped: ingest may write events to columns that are missing or of another type",
    );
    return;
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const problems = await columnProblems(clickhouse);
      if (problems.length === 0) return;
      log.fatal(
        { problems },
        `ClickHouse schema does not match what ingest writes: ${describeProblems(problems)}. Apply the ClickHouse migrations (packages/db) before starting this ingest.`,
      );
      process.exit(1);
    } catch (err) {
      if (attempt >= SCHEMA_CHECK_ATTEMPTS) {
        log.fatal({ err }, "ClickHouse schema check failed: ClickHouse did not answer");
        process.exit(1);
      }
      log.warn({ err, attempt }, "ClickHouse schema check: no answer yet, retrying");
      await new Promise((resolve) => setTimeout(resolve, SCHEMA_CHECK_INTERVAL_MS));
    }
  }
}

async function main() {
  const config = loadConfig();

  const clickhouse = createClickHouseClient(config.clickhouseUrl);
  const writerLog = deferredWriterLogger();
  const batchWriter = new BatchWriter({ clickhouse, logger: writerLog.logger });

  const toolRegistryWriter = new BatchWriter({
    clickhouse,
    table: "tool_registry",
    mapRow: mapToolRegistryRow,
    logger: writerLog.logger,
    flushIntervalMs: 5_000,
    flushSize: 100,
    maxBufferSize: 1_000,
  });

  const { widgetToken, widgetAddress, widgetProject, beacon } = config.rateLimits;
  const rateLimiter = new RateLimiter(
    undefined,
    undefined,
    widgetToken,
    widgetAddress,
    widgetProject,
    beacon,
  );
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
    requestTimeoutMs: config.requestTimeoutMs,
  });
  writerLog.attach(app.log);

  await checkSchema(clickhouse, app.log);
  batchWriter.start();
  toolRegistryWriter.start();

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
    // nothing of them is kept — and a project's shorter retention (#93),
    // which the job applies, is not applied at all.
    app.log.error(
      { variable: "CLICKHOUSE_ROLLUP_PASSWORD" },
      "Statistics job disabled: CLICKHOUSE_ROLLUP_PASSWORD is not set. Raw events expire after 13 months without anonymous statistics being kept, and shorter per-project retention settings are NOT applied.",
    );
  }

  app.addHook("onClose", async () => {
    statsJob?.stop();
    rateLimiter.stop();
    await Promise.all([
      batchWriter.shutdown(WRITER_SHUTDOWN_MS),
      toolRegistryWriter.shutdown(WRITER_SHUTDOWN_MS),
    ]);
  });

  // Without these handlers SIGTERM would not reach the writers: Node as PID 1
  // ignores it (docker-compose.yml runs ingest with `init: true` so that it
  // is not PID 1 and gets the signal), and Node's default for a signal is to
  // exit at once, dropping every buffered event.
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    app.log.info(
      { signal, buffered: batchWriter.bufferedCount + toolRegistryWriter.bufferedCount },
      "Shutting down: no new requests; writing the buffered events",
    );
    setTimeout(() => {
      app.log.error("Shutdown did not finish in time; exiting");
      process.exit(1);
    }, SHUTDOWN_EXIT_MS).unref();
    // close() stops accepting requests, waits for those in flight, then runs
    // the onClose hook above.
    app.close().then(
      () => {
        app.log.info("Shut down");
        process.exit(0);
      },
      (err: unknown) => {
        app.log.error({ err }, "Shutdown failed");
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
  } catch (err) {
    app.log.fatal(err);
    process.exit(1);
  }
}

main();
