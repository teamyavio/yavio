import type { Command } from "commander";
import { execCompose, hasDocker, hasDockerCompose } from "../util/docker.js";
import { createSpinner, error, info, success } from "../util/output.js";

const YAVIO_SERVICES = ["ingest", "dashboard", "docs"];
const ALL_SERVICES = [...YAVIO_SERVICES, "clickhouse", "postgres"];

export function registerUpdate(program: Command): void {
  program
    .command("update")
    .description("Pull latest Docker images and restart services")
    .option("-f, --file <path>", "Path to docker-compose.yml")
    .option("--all", "Also pull third-party images (ClickHouse, PostgreSQL)")
    .option("--dry-run", "Show what would be updated without pulling")
    .action(async (opts: { file?: string; all?: boolean; dryRun?: boolean }) => {
      if (!(await hasDocker()) || !(await hasDockerCompose())) {
        error("Docker or docker compose not available.");
        process.exitCode = 1;
        return;
      }

      const services = opts.all ? ALL_SERVICES : YAVIO_SERVICES;

      if (opts.dryRun) {
        info("Dry run — would pull the following services:");
        for (const svc of services) {
          console.log(`  - ${svc}`);
        }
        return;
      }

      const pullSpinner = createSpinner("Pulling latest images...");
      pullSpinner.start();

      try {
        await execCompose(["pull", ...services], { file: opts.file });
        pullSpinner.succeed("Images pulled");
      } catch (e) {
        pullSpinner.fail("Failed to pull images");
        error((e as Error).message);
        process.exitCode = 1;
        return;
      }

      const restartSpinner = createSpinner("Restarting services...");
      restartSpinner.start();

      try {
        await execCompose(["up", "-d", ...services], { file: opts.file });
        restartSpinner.succeed("Services restarted");
      } catch (e) {
        restartSpinner.fail("Failed to restart services");
        error((e as Error).message);
        process.exitCode = 1;
        return;
      }

      console.log("");
      success("Update complete. Data volumes preserved.");
      success("Dashboard:  http://localhost:3000");
    });
}
