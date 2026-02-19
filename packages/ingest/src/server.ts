import { createClickHouseClient } from "@yavio/db/clickhouse";
import { loadConfig } from "./config.js";
import { createApp } from "./index.js";
import { BatchWriter } from "./lib/batch-writer.js";
import { RateLimiter } from "./lib/rate-limiter.js";

async function main() {
  const config = loadConfig();

  const clickhouse = createClickHouseClient(config.clickhouseUrl);
  const batchWriter = new BatchWriter({ clickhouse });
  batchWriter.start();

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
    rateLimiter,
  });

  app.addHook("onClose", async () => {
    rateLimiter.stop();
    await batchWriter.shutdown();
  });

  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
  } catch (err) {
    app.log.fatal(err);
    process.exit(1);
  }
}

main();
