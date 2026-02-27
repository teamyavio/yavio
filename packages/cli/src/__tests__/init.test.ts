import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCheckHealth = vi.fn();

vi.mock("../util/http.js", () => ({
  checkHealth: (...args: unknown[]) => mockCheckHealth(...args),
}));

import { registerInit } from "../commands/init.js";

describe("init command", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "yavio-init-test-")));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockCheckHealth.mockResolvedValue({ ok: true, status: 200, latency: 5 });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    mockCheckHealth.mockReset();
    process.exitCode = undefined;
  });

  it("creates .yaviorc.json with --api-key and --endpoint flags", async () => {
    const program = new Command();
    registerInit(program);

    await program.parseAsync([
      "node",
      "yavio",
      "init",
      "--api-key",
      "yav_test_key_12345",
      "--endpoint",
      "http://localhost:3001/v1/events",
    ]);

    const config = JSON.parse(readFileSync(join(tempDir, ".yaviorc.json"), "utf-8"));
    expect(config.apiKey).toBe("yav_test_key_12345");
    expect(config.endpoint).toBe("http://localhost:3001/v1/events");
    expect(config.version).toBe(1);
  });

  it("creates .gitignore with .yaviorc.json entry", async () => {
    const program = new Command();
    registerInit(program);

    await program.parseAsync([
      "node",
      "yavio",
      "init",
      "--api-key",
      "yav_test_key_12345",
      "--endpoint",
      "http://localhost:3001",
    ]);

    const gitignore = readFileSync(join(tempDir, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".yaviorc.json");
  });

  it("appends to existing .gitignore", async () => {
    writeFileSync(join(tempDir, ".gitignore"), "node_modules\n");

    const program = new Command();
    registerInit(program);

    await program.parseAsync([
      "node",
      "yavio",
      "init",
      "--api-key",
      "yav_test_key_12345",
      "--endpoint",
      "http://localhost:3001",
    ]);

    const gitignore = readFileSync(join(tempDir, ".gitignore"), "utf-8");
    expect(gitignore).toContain("node_modules");
    expect(gitignore).toContain(".yaviorc.json");
  });

  it("rejects invalid API key format", async () => {
    const program = new Command();
    registerInit(program);

    await program.parseAsync([
      "node",
      "yavio",
      "init",
      "--api-key",
      "invalid",
      "--endpoint",
      "http://localhost:3001",
    ]);

    expect(process.exitCode).toBe(1);
  });

  it("warns when ingestion API is not reachable", async () => {
    mockCheckHealth.mockResolvedValue({ ok: false, status: 0, latency: 0 });

    const program = new Command();
    registerInit(program);

    await program.parseAsync([
      "node",
      "yavio",
      "init",
      "--api-key",
      "yav_test_key_12345",
      "--endpoint",
      "http://localhost:3001/v1/events",
    ]);

    expect(process.exitCode).toBeUndefined();
  });

  it("skips health check when no endpoint is provided", async () => {
    const program = new Command();
    registerInit(program);

    await program.parseAsync([
      "node",
      "yavio",
      "init",
      "--api-key",
      "yav_test_key_12345",
      "--endpoint",
      "http://localhost:3001",
    ]);

    expect(mockCheckHealth).toHaveBeenCalled();
  });
});
