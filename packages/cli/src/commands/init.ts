import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { ensureGitignore, writeConfig } from "../util/config.js";
import { checkHealth } from "../util/http.js";
import { error, info, success, warn } from "../util/output.js";

function isValidApiKey(key: string): boolean {
  return key.startsWith("yav_") && key.length > 10;
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Initialize SDK configuration in the current project")
    .option("--api-key <key>", "API key (non-interactive)")
    .option("--endpoint <url>", "Ingestion endpoint (non-interactive)")
    .action(async (opts: { apiKey?: string; endpoint?: string }) => {
      let apiKey = opts.apiKey;
      let endpoint = opts.endpoint;

      if (!apiKey || !endpoint) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          if (!apiKey) {
            apiKey = await rl.question("Enter your project API key: ");
          }
          if (!endpoint) {
            endpoint = await rl.question("Ingestion endpoint (leave blank for Yavio Cloud): ");
          }
        } finally {
          rl.close();
        }
      }

      if (!apiKey || !isValidApiKey(apiKey)) {
        error("Invalid API key. Keys must start with 'yav_' and be at least 10 characters.");
        process.exitCode = 1;
        return;
      }

      const cwd = process.cwd();
      const config = {
        version: 1,
        apiKey,
        ...(endpoint ? { endpoint } : {}),
      };

      writeConfig(cwd, config);
      success("Created .yaviorc.json");

      ensureGitignore(cwd);
      success("Added .yaviorc.json to .gitignore");

      if (endpoint) {
        const healthUrl = endpoint.replace(/\/v1\/events$/, "/health");
        const result = await checkHealth(healthUrl);
        if (result.ok) {
          success(`Verified connection to ingestion API (${result.latency}ms)`);
        } else {
          warn(`Could not reach ingestion API at ${healthUrl}`);
        }
      }

      console.log("");
      info("Next steps:");
      console.log("  1. Import withYavio in your server:");
      console.log("");
      console.log('     import { withYavio } from "@yavio/sdk";');
      console.log("     const instrumented = withYavio(server);");
      console.log("");
      console.log("  2. withYavio() auto-reads .yaviorc.json — no config needed in code.");
    });
}
