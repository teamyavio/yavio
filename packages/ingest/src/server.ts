import { loadConfig } from "./config.js";
import { createApp } from "./index.js";

async function main() {
  const config = loadConfig();
  const app = await createApp({
    databaseUrl: config.databaseUrl,
    clickhouseUrl: config.clickhouseUrl,
  });

  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
  } catch (err) {
    app.log.fatal(err);
    process.exit(1);
  }
}

main();
