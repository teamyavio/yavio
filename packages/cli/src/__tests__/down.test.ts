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

import { registerDown } from "../commands/down.js";

describe("down command", () => {
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

  it("calls execCompose with down", async () => {
    const program = new Command();
    registerDown(program);

    await program.parseAsync(["node", "yavio", "down", "--file", "/some/compose.yml"]);

    expect(mockExecCompose).toHaveBeenCalledWith(["down"], { file: "/some/compose.yml" });
  });

  it("fails when Docker is not available", async () => {
    mockHasDocker.mockResolvedValueOnce(false);

    const program = new Command();
    registerDown(program);

    await program.parseAsync(["node", "yavio", "down"]);
    expect(process.exitCode).toBe(1);
  });

  it("handles compose failure gracefully", async () => {
    mockExecCompose.mockRejectedValueOnce(new Error("compose failed"));

    const program = new Command();
    registerDown(program);

    await program.parseAsync(["node", "yavio", "down", "--file", "/some/compose.yml"]);
    expect(process.exitCode).toBe(1);
  });

  it("fails when docker compose is not available", async () => {
    mockHasDockerCompose.mockResolvedValueOnce(false);

    const program = new Command();
    registerDown(program);

    await program.parseAsync(["node", "yavio", "down"]);
    expect(process.exitCode).toBe(1);
  });
});
