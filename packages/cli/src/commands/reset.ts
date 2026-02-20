import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import {
  execCompose,
  getComposeProjectName,
  hasDocker,
  hasDockerCompose,
  removeVolumes,
} from "../util/docker.js";
import { createSpinner, error, success, warn } from "../util/output.js";

export function registerReset(program: Command): void {
  program
    .command("reset")
    .description("Wipe data volumes and reinitialize the platform")
    .option("-f, --file <path>", "Path to docker-compose.yml")
    .option("--yes", "Skip confirmation prompt (requires --confirm-destructive)")
    .option("--confirm-destructive", "Confirm destructive action")
    .option("--keep-config", "Preserve PostgreSQL data, only wipe ClickHouse events")
    .action(
      async (opts: {
        file?: string;
        yes?: boolean;
        confirmDestructive?: boolean;
        keepConfig?: boolean;
      }) => {
        if (!(await hasDocker()) || !(await hasDockerCompose())) {
          error("Docker or docker compose not available.");
          process.exitCode = 1;
          return;
        }

        // Confirmation logic
        if (opts.yes && !opts.confirmDestructive) {
          error("--yes requires --confirm-destructive to prevent accidental data loss.");
          process.exitCode = 1;
          return;
        }

        if (!opts.yes || !opts.confirmDestructive) {
          warn("This will permanently delete all data:");
          console.log("  - ClickHouse: all analytics events");
          if (!opts.keepConfig) {
            console.log("  - PostgreSQL: all workspaces, projects, users, API keys");
          }
          console.log("");

          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            const answer = await rl.question('Are you sure? Type "reset" to confirm: ');
            if (answer !== "reset") {
              error("Reset cancelled.");
              process.exitCode = 1;
              return;
            }
          } finally {
            rl.close();
          }
        }

        // Stop services
        const stopSpinner = createSpinner("Stopping services...");
        stopSpinner.start();
        try {
          await execCompose(["down"], { file: opts.file });
          stopSpinner.succeed("All services stopped");
        } catch (e) {
          stopSpinner.fail("Failed to stop services");
          error((e as Error).message);
          process.exitCode = 1;
          return;
        }

        // Remove volumes
        const volumeSpinner = createSpinner("Removing data volumes...");
        volumeSpinner.start();
        try {
          if (opts.keepConfig) {
            // Selectively remove only the ClickHouse volume, preserve PostgreSQL
            const projectName = getComposeProjectName(opts.file);
            await removeVolumes([`${projectName}_clickhouse_data`]);
          } else {
            await execCompose(["down", "-v", "--remove-orphans"], { file: opts.file });
          }
          volumeSpinner.succeed("Data volumes removed");
        } catch (e) {
          volumeSpinner.fail("Failed to remove volumes");
          error((e as Error).message);
          process.exitCode = 1;
          return;
        }

        // Restart
        const startSpinner = createSpinner("Starting fresh platform...");
        startSpinner.start();
        try {
          await execCompose(["up", "-d"], { file: opts.file });
          startSpinner.succeed("Platform restarted");
        } catch (e) {
          startSpinner.fail("Failed to restart");
          error((e as Error).message);
          process.exitCode = 1;
          return;
        }

        console.log("");
        success("Platform reset complete. Create a new account at http://localhost:3000");
      },
    );
}
