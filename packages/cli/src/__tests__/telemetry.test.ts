import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTelemetry } from "../commands/telemetry.js";

describe("telemetry command", () => {
  let consoleLogs: string[];
  let globalDir: string;
  const originalHome = process.env.HOME;
  const originalEnv = process.env.YAVIO_TELEMETRY;

  beforeEach(() => {
    consoleLogs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    globalDir = mkdtempSync(join(tmpdir(), "yavio-telemetry-test-"));
    process.env.HOME = globalDir;
    process.env.YAVIO_TELEMETRY = undefined;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalEnv !== undefined) {
      process.env.YAVIO_TELEMETRY = originalEnv;
    } else {
      process.env.YAVIO_TELEMETRY = undefined;
    }
    rmSync(globalDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("disables telemetry and writes config file", async () => {
    const program = new Command();
    registerTelemetry(program);

    await program.parseAsync(["node", "yavio", "telemetry", "disable"]);

    const configPath = join(globalDir, ".yavio", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.telemetry).toBe(false);

    const output = consoleLogs.join("\n");
    expect(output).toContain("disabled");
  });

  it("enables telemetry after being disabled", async () => {
    // First create a config with telemetry disabled
    const yavioDir = join(globalDir, ".yavio");
    mkdirSync(yavioDir, { recursive: true });
    const configPath = join(yavioDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ telemetry: false }));

    const program = new Command();
    registerTelemetry(program);

    await program.parseAsync(["node", "yavio", "telemetry", "enable"]);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.telemetry).toBe(true);
  });

  it("shows telemetry status as enabled by default", async () => {
    const program = new Command();
    registerTelemetry(program);

    await program.parseAsync(["node", "yavio", "telemetry", "status"]);

    const output = consoleLogs.join("\n");
    // Default is enabled when no config file exists
    expect(output).toContain("enabled");
  });

  it("respects YAVIO_TELEMETRY env var", async () => {
    process.env.YAVIO_TELEMETRY = "false";

    const program = new Command();
    registerTelemetry(program);

    await program.parseAsync(["node", "yavio", "telemetry", "status"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("disabled");
    expect(output).toContain("env var");
  });
});
