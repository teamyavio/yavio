import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockHasDocker = vi.fn().mockResolvedValue(true);
const mockHasDockerCompose = vi.fn().mockResolvedValue(true);
const mockExecCompose = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

vi.mock("../util/docker.js", () => ({
  hasDocker: (...args: unknown[]) => mockHasDocker(...args),
  hasDockerCompose: (...args: unknown[]) => mockHasDockerCompose(...args),
  execCompose: (...args: unknown[]) => mockExecCompose(...args),
}));

import { registerLogs } from "../commands/logs.js";

describe("logs command", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockHasDocker.mockResolvedValue(true);
    mockHasDockerCompose.mockResolvedValue(true);
    mockExecCompose.mockResolvedValue({ stdout: "", stderr: "" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockHasDocker.mockReset().mockResolvedValue(true);
    mockHasDockerCompose.mockReset().mockResolvedValue(true);
    mockExecCompose.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
    process.exitCode = undefined;
  });

  it("passes correct arguments for a specific service", async () => {
    const program = new Command();
    registerLogs(program);

    await program.parseAsync(["node", "yavio", "logs", "ingest", "--file", "/some/compose.yml"]);

    expect(mockExecCompose).toHaveBeenCalledWith(["logs", "--tail=100", "--follow", "ingest"], {
      file: "/some/compose.yml",
      stdio: "inherit",
    });
  });

  it("passes --no-follow correctly", async () => {
    const program = new Command();
    registerLogs(program);

    await program.parseAsync([
      "node",
      "yavio",
      "logs",
      "--no-follow",
      "--file",
      "/some/compose.yml",
    ]);

    expect(mockExecCompose).toHaveBeenCalledWith(["logs", "--tail=100"], {
      file: "/some/compose.yml",
      stdio: "inherit",
    });
  });

  it("passes custom --lines count", async () => {
    const program = new Command();
    registerLogs(program);

    await program.parseAsync([
      "node",
      "yavio",
      "logs",
      "-n",
      "50",
      "--no-follow",
      "--file",
      "/some/compose.yml",
    ]);

    expect(mockExecCompose).toHaveBeenCalledWith(["logs", "--tail=50"], {
      file: "/some/compose.yml",
      stdio: "inherit",
    });
  });

  it("rejects unknown service names", async () => {
    const program = new Command();
    registerLogs(program);

    await program.parseAsync(["node", "yavio", "logs", "unknown-service"]);
    expect(process.exitCode).toBe(1);
  });
});
