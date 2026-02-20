import type { Command } from "commander";
import { execCompose, hasDocker, hasDockerCompose } from "../util/docker.js";
import { error } from "../util/output.js";

const SERVICE_MAP: Record<string, string> = {
  dashboard: "dashboard",
  ingest: "ingest",
  clickhouse: "clickhouse",
  postgres: "postgres",
  docs: "docs",
};

export function registerLogs(program: Command): void {
  program
    .command("logs [service]")
    .description("Tail logs for platform services")
    .option("-f, --file <path>", "Path to docker-compose.yml")
    .option("-n, --lines <count>", "Number of historical lines", "100")
    .option("--no-follow", "Print logs and exit instead of following")
    .action(
      async (
        service: string | undefined,
        opts: { file?: string; lines: string; follow: boolean },
      ) => {
        if (!(await hasDocker()) || !(await hasDockerCompose())) {
          error("Docker or docker compose not available.");
          process.exitCode = 1;
          return;
        }

        if (service && !SERVICE_MAP[service]) {
          error(
            `Unknown service: ${service}. Valid services: ${Object.keys(SERVICE_MAP).join(", ")}`,
          );
          process.exitCode = 1;
          return;
        }

        const args = ["logs", `--tail=${opts.lines}`];
        if (opts.follow) {
          args.push("--follow");
        }
        if (service) {
          args.push(SERVICE_MAP[service]);
        }

        try {
          await execCompose(args, { file: opts.file, stdio: "inherit" });
        } catch (e) {
          error((e as Error).message);
          process.exitCode = 1;
        }
      },
    );
}
