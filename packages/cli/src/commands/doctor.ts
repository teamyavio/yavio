import { createServer } from "node:net";
import type { Command } from "commander";
import pc from "picocolors";
import { readConfig } from "../util/config.js";
import {
  getComposeVersion,
  getDockerVersion,
  hasDocker,
  hasDockerCompose,
} from "../util/docker.js";
import { checkHealth } from "../util/http.js";
import { error, success, warn } from "../util/output.js";

function checkNodeVersion(): { ok: boolean; version: string } {
  const version = process.version;
  const major = Number.parseInt(version.slice(1).split(".")[0], 10);
  return { ok: major >= 20, version };
}

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose common setup issues")
    .action(async () => {
      console.log("");
      console.log(pc.bold("Yavio Doctor"));
      console.log(pc.dim("────────────"));

      let allPassed = true;

      // Node.js version
      const node = checkNodeVersion();
      if (node.ok) {
        success(`Node.js ${node.version} (>= 20 required)`);
      } else {
        error(`Node.js ${node.version} — version 20+ required`);
        allPassed = false;
      }

      // Docker
      const dockerVersion = await getDockerVersion();
      if (dockerVersion) {
        success(`Docker v${dockerVersion} available`);
      } else if (await hasDocker()) {
        warn("Docker available but could not parse version");
      } else {
        error("Docker not found");
        allPassed = false;
      }

      // Docker Compose
      const composeVersion = await getComposeVersion();
      if (composeVersion) {
        success(`docker compose v${composeVersion} available`);
      } else if (await hasDockerCompose()) {
        warn("docker compose available but could not parse version");
      } else {
        error("docker compose not found");
        allPassed = false;
      }

      // Config file
      const config = readConfig();
      if (config) {
        const maskedKey = config.config.apiKey ? `${config.config.apiKey.slice(0, 12)}...` : "none";
        success(`.yaviorc.json found (API key: ${maskedKey})`);
      } else {
        warn(".yaviorc.json not found (run 'yavio init' to create)");
      }

      // Service connectivity
      const endpoints = [
        { name: "Ingestion API", url: "http://localhost:3001/health" },
        { name: "Dashboard", url: "http://localhost:3000/api/health" },
      ];

      for (const ep of endpoints) {
        const result = await checkHealth(ep.url, 3000);
        if (result.ok) {
          success(`${ep.name} reachable at ${ep.url}`);
        } else {
          warn(`${ep.name} not reachable at ${ep.url}`);
        }
      }

      // TLS warning
      if (config?.config.endpoint) {
        const url = new URL(config.config.endpoint);
        if (
          url.protocol === "http:" &&
          url.hostname !== "localhost" &&
          url.hostname !== "127.0.0.1"
        ) {
          warn("Endpoint uses HTTP on non-localhost — consider using HTTPS");
        }
      }

      // Port conflicts
      const ports = [
        { port: 3000, label: "Dashboard" },
        { port: 3001, label: "Ingest" },
        { port: 5432, label: "PostgreSQL" },
        { port: 8123, label: "ClickHouse HTTP" },
      ];

      const conflicts: string[] = [];
      for (const p of ports) {
        const available = await checkPort(p.port);
        if (!available) {
          conflicts.push(`${p.port} (${p.label})`);
        }
      }

      if (conflicts.length === 0) {
        success(`No port conflicts detected (${ports.map((p) => p.port).join(", ")})`);
      } else {
        warn(`Port conflicts: ${conflicts.join(", ")}`);
      }

      console.log("");
      if (allPassed) {
        console.log(pc.green("All critical checks passed."));
      } else {
        console.log(pc.red("Some critical checks failed."));
      }
    });
}
