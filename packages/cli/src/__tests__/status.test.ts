import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockHasDocker = vi.fn();
const mockHasDockerCompose = vi.fn();
const mockGetContainerStatus = vi.fn();
const mockCheckHealth = vi.fn();

vi.mock("../util/docker.js", () => ({
  hasDocker: () => mockHasDocker(),
  hasDockerCompose: () => mockHasDockerCompose(),
  getContainerStatus: (...args: unknown[]) => mockGetContainerStatus(...args),
}));

vi.mock("../util/http.js", () => ({
  checkHealth: (...args: unknown[]) => mockCheckHealth(...args),
}));

import { registerStatus } from "../commands/status.js";

const defaultContainers = [
  {
    Name: "yavio-dashboard-1",
    Service: "dashboard",
    State: "running",
    Status: "Up 2 hours",
    Health: "healthy",
  },
  {
    Name: "yavio-ingest-1",
    Service: "ingest",
    State: "running",
    Status: "Up 2 hours",
    Health: "healthy",
  },
  {
    Name: "yavio-postgres-1",
    Service: "postgres",
    State: "running",
    Status: "Up 2 hours",
    Health: "healthy",
  },
  {
    Name: "yavio-clickhouse-1",
    Service: "clickhouse",
    State: "running",
    Status: "Up 2 hours",
    Health: "healthy",
  },
];

describe("status command", () => {
  let consoleLogs: string[];

  beforeEach(() => {
    consoleLogs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockHasDocker.mockResolvedValue(true);
    mockHasDockerCompose.mockResolvedValue(true);
    mockGetContainerStatus.mockResolvedValue(defaultContainers);
    mockCheckHealth.mockResolvedValue({ ok: true, status: 200, latency: 5 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockHasDocker.mockReset();
    mockHasDockerCompose.mockReset();
    mockGetContainerStatus.mockReset();
    mockCheckHealth.mockReset();
    process.exitCode = undefined;
  });

  it("shows healthy status for all services", async () => {
    const program = new Command();
    registerStatus(program);

    await program.parseAsync(["node", "yavio", "status", "--file", "/some/compose.yml"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("Yavio Platform");
    expect(output).toContain("healthy");
  });

  it("shows unreachable services", async () => {
    mockCheckHealth.mockResolvedValue({ ok: false, status: 0, latency: 0 });
    mockGetContainerStatus.mockResolvedValue(defaultContainers);

    const program = new Command();
    registerStatus(program);

    await program.parseAsync(["node", "yavio", "status", "--file", "/some/compose.yml"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("unreachable");
  });

  it("fails when Docker is not available", async () => {
    mockHasDocker.mockResolvedValueOnce(false);

    const program = new Command();
    registerStatus(program);

    await program.parseAsync(["node", "yavio", "status"]);
    expect(process.exitCode).toBe(1);
  });
});
