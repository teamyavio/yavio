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

vi.mock("ora", () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  }),
}));

import { registerUpdate } from "../commands/update.js";

describe("update command", () => {
  let consoleLogs: string[];

  beforeEach(() => {
    consoleLogs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(" "));
    });
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

  it("pulls yavio services by default", async () => {
    const program = new Command();
    registerUpdate(program);

    await program.parseAsync(["node", "yavio", "update", "--file", "/some/compose.yml"]);

    const calls = mockExecCompose.mock.calls;
    expect(calls[0][0]).toEqual(["pull", "ingest", "dashboard", "docs"]);
    expect(calls[1][0]).toEqual(["up", "-d", "ingest", "dashboard", "docs"]);
  });

  it("pulls all services with --all flag", async () => {
    const program = new Command();
    registerUpdate(program);

    await program.parseAsync(["node", "yavio", "update", "--all", "--file", "/some/compose.yml"]);

    const calls = mockExecCompose.mock.calls;
    expect(calls[0][0]).toContain("clickhouse");
    expect(calls[0][0]).toContain("postgres");
  });

  it("shows services in dry-run mode without pulling", async () => {
    const program = new Command();
    registerUpdate(program);

    await program.parseAsync(["node", "yavio", "update", "--dry-run"]);

    expect(mockExecCompose).not.toHaveBeenCalled();
    const output = consoleLogs.join("\n");
    expect(output).toContain("ingest");
    expect(output).toContain("dashboard");
  });

  it("fails when Docker is not available", async () => {
    mockHasDocker.mockResolvedValueOnce(false);

    const program = new Command();
    registerUpdate(program);

    await program.parseAsync(["node", "yavio", "update", "--file", "/some/compose.yml"]);
    expect(process.exitCode).toBe(1);
  });

  it("handles pull failure", async () => {
    mockExecCompose.mockRejectedValueOnce(new Error("pull failed"));

    const program = new Command();
    registerUpdate(program);

    await program.parseAsync(["node", "yavio", "update", "--file", "/some/compose.yml"]);
    expect(process.exitCode).toBe(1);
  });

  it("handles restart failure after successful pull", async () => {
    mockExecCompose
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("restart failed"));

    const program = new Command();
    registerUpdate(program);

    await program.parseAsync(["node", "yavio", "update", "--file", "/some/compose.yml"]);
    expect(process.exitCode).toBe(1);
  });
});
