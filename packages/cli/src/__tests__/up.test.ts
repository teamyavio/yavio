import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockHasDocker = vi.fn();
const mockHasDockerCompose = vi.fn();
const mockResolveComposeFile = vi.fn();
const mockExecCompose = vi.fn();
const mockCheckHealth = vi.fn();

vi.mock("../util/docker.js", () => ({
  hasDocker: () => mockHasDocker(),
  hasDockerCompose: () => mockHasDockerCompose(),
  resolveComposeFile: (...args: unknown[]) => mockResolveComposeFile(...args),
  execCompose: (...args: unknown[]) => mockExecCompose(...args),
}));

vi.mock("../util/http.js", () => ({
  checkHealth: (...args: unknown[]) => mockCheckHealth(...args),
}));

vi.mock("ora", () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
  }),
}));

import { registerUp } from "../commands/up.js";

describe("up command", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "yavio-up-test-")));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockHasDocker.mockResolvedValue(true);
    mockHasDockerCompose.mockResolvedValue(true);
    mockExecCompose.mockResolvedValue({ stdout: "", stderr: "" });
    mockCheckHealth.mockResolvedValue({ ok: true, status: 200, latency: 5 });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    mockHasDocker.mockReset();
    mockHasDockerCompose.mockReset();
    mockResolveComposeFile.mockReset();
    mockExecCompose.mockReset();
    mockCheckHealth.mockReset();
    process.exitCode = undefined;
  });

  it("fails when Docker is not available", async () => {
    mockHasDocker.mockResolvedValueOnce(false);

    const program = new Command();
    registerUp(program);

    await program.parseAsync(["node", "yavio", "up"]);
    expect(process.exitCode).toBe(1);
  });

  it("fails when docker compose is not available", async () => {
    mockHasDocker.mockResolvedValueOnce(true);
    mockHasDockerCompose.mockResolvedValueOnce(false);

    const program = new Command();
    registerUp(program);

    await program.parseAsync(["node", "yavio", "up"]);
    expect(process.exitCode).toBe(1);
  });

  it("calls execCompose with up -d", async () => {
    const composePath = join(tempDir, "docker-compose.yml");
    writeFileSync(composePath, "services: {}");
    mockHasDocker.mockResolvedValue(true);
    mockHasDockerCompose.mockResolvedValue(true);
    mockResolveComposeFile.mockReturnValue(composePath);
    mockExecCompose.mockResolvedValue({ stdout: "", stderr: "" });
    mockCheckHealth.mockResolvedValue({ ok: true, status: 200, latency: 5 });

    const program = new Command();
    registerUp(program);

    await program.parseAsync(["node", "yavio", "up", "--file", composePath]);

    expect(mockExecCompose).toHaveBeenCalledWith(["up", "-d"], { files: [composePath] });
  });

  it("passes --build flag to compose", async () => {
    const composePath = join(tempDir, "docker-compose.yml");
    writeFileSync(composePath, "services: {}");
    mockHasDocker.mockResolvedValue(true);
    mockHasDockerCompose.mockResolvedValue(true);
    mockResolveComposeFile.mockReturnValue(composePath);
    mockExecCompose.mockResolvedValue({ stdout: "", stderr: "" });
    mockCheckHealth.mockResolvedValue({ ok: true, status: 200, latency: 5 });

    const program = new Command();
    registerUp(program);

    await program.parseAsync(["node", "yavio", "up", "--file", composePath, "--build"]);

    expect(mockExecCompose).toHaveBeenCalledWith(["up", "-d", "--build"], {
      files: [composePath],
    });
  });

  it("includes prod overlay when --prod flag is set", async () => {
    const composePath = join(tempDir, "docker-compose.yml");
    const prodPath = join(tempDir, "docker-compose.prod.yml");
    writeFileSync(composePath, "services: {}");
    writeFileSync(prodPath, "services: {}");
    mockHasDocker.mockResolvedValue(true);
    mockHasDockerCompose.mockResolvedValue(true);
    mockResolveComposeFile.mockReturnValue(composePath);
    mockExecCompose.mockResolvedValue({ stdout: "", stderr: "" });
    mockCheckHealth.mockResolvedValue({ ok: true, status: 200, latency: 5 });

    const program = new Command();
    registerUp(program);

    await program.parseAsync(["node", "yavio", "up", "--file", composePath, "--prod"]);

    expect(mockExecCompose).toHaveBeenCalledWith(["up", "-d"], {
      files: [composePath, prodPath],
    });
  });
});
