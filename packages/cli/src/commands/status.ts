import type { Command } from "commander";
import pc from "picocolors";
import { getContainerStatus, hasDocker, hasDockerCompose } from "../util/docker.js";
import { checkHealth } from "../util/http.js";
import { error, table } from "../util/output.js";

const SERVICES = [
  { name: "Dashboard", url: "http://localhost:3000/api/health", compose: "dashboard" },
  { name: "Ingestion API", url: "http://localhost:3001/health", compose: "ingest" },
  { name: "ClickHouse", url: "http://localhost:8123/ping", compose: "clickhouse" },
] as const;

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show platform service health and status")
    .option("-f, --file <path>", "Path to docker-compose.yml")
    .action(async (opts: { file?: string }) => {
      if (!(await hasDocker()) || !(await hasDockerCompose())) {
        error("Docker or docker compose not available.");
        process.exitCode = 1;
        return;
      }

      console.log("");
      console.log(pc.bold("Yavio Platform"));
      console.log(pc.dim("────────────────────────"));

      const containers = await getContainerStatus(opts.file);
      const rows: [string, string][] = [];

      for (const svc of SERVICES) {
        const health = await checkHealth(svc.url, 3000);
        const container = containers.find((c) => c.Service === svc.compose);
        const uptime = container?.Status ?? "not running";

        if (health.ok) {
          rows.push([`${svc.name}:`, `${pc.green("✓ healthy")} (${uptime})`]);
        } else {
          rows.push([`${svc.name}:`, `${pc.red("✗ unreachable")} (${uptime})`]);
        }
      }

      // PostgreSQL — check via container status (no HTTP endpoint)
      const pgContainer = containers.find((c) => c.Service === "postgres");
      if (pgContainer) {
        const pgHealthy = pgContainer.Health === "healthy" || pgContainer.State === "running";
        rows.push([
          "PostgreSQL:",
          pgHealthy
            ? `${pc.green("✓ healthy")} (${pgContainer.Status})`
            : `${pc.red("✗ unhealthy")} (${pgContainer.Status})`,
        ]);
      } else {
        rows.push(["PostgreSQL:", `${pc.red("✗ not running")}`]);
      }

      table(rows);
      console.log("");
    });
}
