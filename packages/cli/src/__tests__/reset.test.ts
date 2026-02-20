import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockHasDocker = vi.fn().mockResolvedValue(true);
const mockHasDockerCompose = vi.fn().mockResolvedValue(true);
const mockExecCompose = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
const mockGetComposeProjectName = vi.fn().mockReturnValue("yavio");
const mockRemoveVolumes = vi.fn().mockResolvedValue(undefined);

vi.mock("../util/docker.js", () => ({
  hasDocker: (...args: unknown[]) => mockHasDocker(...args),
  hasDockerCompose: (...args: unknown[]) => mockHasDockerCompose(...args),
  execCompose: (...args: unknown[]) => mockExecCompose(...args),
  getComposeProjectName: (...args: unknown[]) => mockGetComposeProjectName(...args),
  removeVolumes: (...args: unknown[]) => mockRemoveVolumes(...args),
}));

vi.mock("ora", () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  }),
}));

import { registerReset } from "../commands/reset.js";

describe("reset command", () => {
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
    mockGetComposeProjectName.mockReset().mockReturnValue("yavio");
    mockRemoveVolumes.mockReset().mockResolvedValue(undefined);
    process.exitCode = undefined;
  });

  it("rejects --yes without --confirm-destructive", async () => {
    const program = new Command();
    registerReset(program);

    await program.parseAsync(["node", "yavio", "reset", "--yes", "--file", "/some/compose.yml"]);
    expect(process.exitCode).toBe(1);
  });

  it("proceeds with --yes --confirm-destructive", async () => {
    const program = new Command();
    registerReset(program);

    await program.parseAsync([
      "node",
      "yavio",
      "reset",
      "--yes",
      "--confirm-destructive",
      "--file",
      "/some/compose.yml",
    ]);

    // Should have called down, down -v, and up -d
    const calls = mockExecCompose.mock.calls;
    expect(calls.length).toBe(3);
    expect(calls[0][0]).toEqual(["down"]);
    expect(calls[1][0]).toContain("-v");
    expect(calls[2][0]).toEqual(["up", "-d"]);
  });

  it("selectively removes only ClickHouse volume with --keep-config", async () => {
    const program = new Command();
    registerReset(program);

    await program.parseAsync([
      "node",
      "yavio",
      "reset",
      "--yes",
      "--confirm-destructive",
      "--keep-config",
      "--file",
      "/some/compose.yml",
    ]);

    // Should call down (stop), removeVolumes (selective), up -d (restart)
    const composeCalls = mockExecCompose.mock.calls;
    expect(composeCalls.length).toBe(2);
    expect(composeCalls[0][0]).toEqual(["down"]);
    expect(composeCalls[1][0]).toEqual(["up", "-d"]);

    // Should only remove clickhouse volume
    expect(mockRemoveVolumes).toHaveBeenCalledWith(["yavio_clickhouse_data"]);
  });

  it("fails when Docker is not available", async () => {
    mockHasDocker.mockResolvedValueOnce(false);

    const program = new Command();
    registerReset(program);

    await program.parseAsync(["node", "yavio", "reset", "--yes", "--confirm-destructive"]);
    expect(process.exitCode).toBe(1);
  });
});
