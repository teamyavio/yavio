import type { Command } from "commander";
import { readGlobalConfig, writeGlobalConfig } from "../util/config.js";
import { info, success } from "../util/output.js";

function isTelemetryEnabled(): boolean {
  const envVar = process.env.YAVIO_TELEMETRY;
  if (envVar !== undefined) {
    return envVar !== "0" && envVar !== "false";
  }
  const config = readGlobalConfig();
  return config.telemetry !== false;
}

export function registerTelemetry(program: Command): void {
  const cmd = program.command("telemetry").description("Manage anonymous usage telemetry");

  cmd
    .command("status")
    .description("Show telemetry status")
    .action(() => {
      const envOverride = process.env.YAVIO_TELEMETRY;
      const enabled = isTelemetryEnabled();

      if (envOverride !== undefined) {
        info(`Telemetry: ${enabled ? "enabled" : "disabled"} (via YAVIO_TELEMETRY env var)`);
      } else {
        info(`Telemetry: ${enabled ? "enabled" : "disabled"}`);
      }
    });

  cmd
    .command("enable")
    .description("Enable anonymous usage telemetry")
    .action(() => {
      const config = readGlobalConfig();
      writeGlobalConfig({ ...config, telemetry: true });
      success("Telemetry enabled.");
    });

  cmd
    .command("disable")
    .description("Disable anonymous usage telemetry")
    .action(() => {
      const config = readGlobalConfig();
      writeGlobalConfig({ ...config, telemetry: false });
      success("Telemetry disabled.");
    });
}
