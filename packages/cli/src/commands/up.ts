import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Command } from "commander";
import { execCompose, hasDocker, hasDockerCompose, resolveComposeFile } from "../util/docker.js";
import { checkHealth } from "../util/http.js";
import { createSpinner, error, success, warn } from "../util/output.js";

const HEALTH_ENDPOINTS = [
  { name: "Dashboard", url: "http://localhost:3000/api/health" },
  { name: "Ingestion API", url: "http://localhost:3001/health" },
];

export function registerUp(program: Command): void {
  program
    .command("up")
    .description("Start the self-hosted Yavio platform")
    .option("-f, --file <path>", "Path to docker-compose.yml")
    .option("--build", "Rebuild images before starting")
    .option("--prod", "Use production compose overrides")
    .action(async (opts: { file?: string; build?: boolean; prod?: boolean }) => {
      // Pre-flight checks
      if (!(await hasDocker())) {
        error("Docker is not installed or not in PATH.");
        process.exitCode = 1;
        return;
      }
      if (!(await hasDockerCompose())) {
        error("docker compose is not available. Install Docker Compose v2+.");
        process.exitCode = 1;
        return;
      }

      let composeFile: string;
      try {
        composeFile = resolveComposeFile(opts.file);
      } catch (e) {
        error((e as Error).message);
        process.exitCode = 1;
        return;
      }

      const composeDir = dirname(composeFile);
      const envFile = `${composeDir}/.env`;
      if (!existsSync(envFile)) {
        warn("No .env file found. Default values will be used.");
      }

      const spinner = createSpinner("Starting Yavio Platform...");
      spinner.start();

      try {
        const args = ["up", "-d"];
        if (opts.build) args.push("--build");

        const files: string[] = [composeFile];
        if (opts.prod) {
          const prodFile = `${composeDir}/docker-compose.prod.yml`;
          if (existsSync(prodFile)) {
            files.push(prodFile);
          } else {
            warn("docker-compose.prod.yml not found, skipping production overrides.");
          }
        }

        await execCompose(args, { files });

        spinner.succeed("Services started");
      } catch (e) {
        spinner.fail("Failed to start services");
        error((e as Error).message);
        process.exitCode = 1;
        return;
      }

      // Poll health endpoints
      const healthSpinner = createSpinner("Waiting for services to be healthy...");
      healthSpinner.start();

      const deadline = Date.now() + 60_000;
      const healthy = new Map<string, boolean>();

      for (;;) {
        if (Date.now() > deadline) break;

        for (const ep of HEALTH_ENDPOINTS) {
          if (healthy.get(ep.name)) continue;
          const result = await checkHealth(ep.url, 3000);
          if (result.ok) {
            healthy.set(ep.name, true);
          }
        }

        if (healthy.size === HEALTH_ENDPOINTS.length) break;
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (healthy.size === HEALTH_ENDPOINTS.length) {
        healthSpinner.succeed("All services healthy");
      } else {
        healthSpinner.warn("Some services may not be healthy yet");
        for (const ep of HEALTH_ENDPOINTS) {
          if (!healthy.get(ep.name)) {
            warn(`${ep.name} not responding at ${ep.url}`);
          }
        }
      }

      console.log("");
      success("Dashboard:  http://localhost:3000");
      success("Ingestion:  http://localhost:3001/v1/events");
    });
}
