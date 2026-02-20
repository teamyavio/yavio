import type { Command } from "commander";
import { execCompose, hasDocker, hasDockerCompose } from "../util/docker.js";
import { createSpinner, error, info, success } from "../util/output.js";

export function registerDown(program: Command): void {
  program
    .command("down")
    .description("Stop the self-hosted Yavio platform")
    .option("-f, --file <path>", "Path to docker-compose.yml")
    .action(async (opts: { file?: string }) => {
      if (!(await hasDocker())) {
        error("Docker is not installed or not in PATH.");
        process.exitCode = 1;
        return;
      }
      if (!(await hasDockerCompose())) {
        error("docker compose is not available.");
        process.exitCode = 1;
        return;
      }

      const spinner = createSpinner("Stopping Yavio Platform...");
      spinner.start();

      try {
        await execCompose(["down"], { file: opts.file });
        spinner.succeed("All services stopped");
        info("Data volumes preserved.");
      } catch (e) {
        spinner.fail("Failed to stop services");
        error((e as Error).message);
        process.exitCode = 1;
      }
    });
}
