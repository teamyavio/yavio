import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockHasDocker = vi.fn();
const mockHasDockerCompose = vi.fn();
const mockGetDockerVersion = vi.fn();
const mockGetComposeVersion = vi.fn();
const mockCheckHealth = vi.fn();

vi.mock("../util/docker.js", () => ({
  hasDocker: () => mockHasDocker(),
  hasDockerCompose: () => mockHasDockerCompose(),
  getDockerVersion: () => mockGetDockerVersion(),
  getComposeVersion: () => mockGetComposeVersion(),
}));

vi.mock("../util/http.js", () => ({
  checkHealth: (...args: unknown[]) => mockCheckHealth(...args),
}));

import { registerDoctor } from "../commands/doctor.js";

describe("doctor command", () => {
  let consoleLogs: string[];
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    consoleLogs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(" "));
    });
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "yavio-doctor-test-")));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    mockHasDocker.mockResolvedValue(true);
    mockHasDockerCompose.mockResolvedValue(true);
    mockGetDockerVersion.mockResolvedValue("27.0.1");
    mockGetComposeVersion.mockResolvedValue("2.28.0");
    mockCheckHealth.mockResolvedValue({ ok: true, status: 200, latency: 5 });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    mockHasDocker.mockReset();
    mockHasDockerCompose.mockReset();
    mockGetDockerVersion.mockReset();
    mockGetComposeVersion.mockReset();
    mockCheckHealth.mockReset();
  });

  it("reports Node.js version", async () => {
    const program = new Command();
    registerDoctor(program);

    await program.parseAsync(["node", "yavio", "doctor"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("Node.js");
  });

  it("reports Docker version", async () => {
    const program = new Command();
    registerDoctor(program);

    await program.parseAsync(["node", "yavio", "doctor"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("27.0.1");
  });

  it("reports docker compose version", async () => {
    const program = new Command();
    registerDoctor(program);

    await program.parseAsync(["node", "yavio", "doctor"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("2.28.0");
  });

  it("warns when .yaviorc.json is not found", async () => {
    const program = new Command();
    registerDoctor(program);

    await program.parseAsync(["node", "yavio", "doctor"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("not found");
  });

  it("shows config info when .yaviorc.json exists", async () => {
    writeFileSync(
      join(tempDir, ".yaviorc.json"),
      JSON.stringify({ version: 1, apiKey: "yav_test_key_12345" }),
    );

    const program = new Command();
    registerDoctor(program);

    await program.parseAsync(["node", "yavio", "doctor"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("yaviorc.json found");
    // The key is masked: first 12 chars + "..."
    expect(output).toContain("yav_test_key");
  });

  it("reports missing Docker", async () => {
    mockGetDockerVersion.mockResolvedValue(null);
    mockHasDocker.mockResolvedValue(false);

    const program = new Command();
    registerDoctor(program);

    await program.parseAsync(["node", "yavio", "doctor"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("Docker not found");
  });

  it("warns when Docker version cannot be parsed", async () => {
    mockGetDockerVersion.mockResolvedValue(null);
    mockHasDocker.mockResolvedValue(true);

    const program = new Command();
    registerDoctor(program);

    await program.parseAsync(["node", "yavio", "doctor"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("could not parse version");
  });

  it("warns when compose version cannot be parsed", async () => {
    mockGetComposeVersion.mockResolvedValue(null);
    mockHasDockerCompose.mockResolvedValue(true);

    const program = new Command();
    registerDoctor(program);

    await program.parseAsync(["node", "yavio", "doctor"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("could not parse version");
  });

  it("reports missing docker compose", async () => {
    mockGetComposeVersion.mockResolvedValue(null);
    mockHasDockerCompose.mockResolvedValue(false);

    const program = new Command();
    registerDoctor(program);

    await program.parseAsync(["node", "yavio", "doctor"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("docker compose not found");
  });

  it("warns about HTTP endpoint on non-localhost", async () => {
    writeFileSync(
      join(tempDir, ".yaviorc.json"),
      JSON.stringify({
        version: 1,
        apiKey: "yav_test_key_12345",
        endpoint: "http://example.com/v1/events",
      }),
    );

    const program = new Command();
    registerDoctor(program);

    await program.parseAsync(["node", "yavio", "doctor"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("HTTP on non-localhost");
  });

  it("reports all checks passed when everything is healthy", async () => {
    const program = new Command();
    registerDoctor(program);

    await program.parseAsync(["node", "yavio", "doctor"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("All critical checks passed");
  });

  it("warns about unreachable endpoints", async () => {
    mockCheckHealth.mockResolvedValue({ ok: false, status: 0, latency: 0 });

    const program = new Command();
    registerDoctor(program);

    await program.parseAsync(["node", "yavio", "doctor"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("not reachable");
  });

  it("reports some checks failed when critical issues found", async () => {
    mockGetDockerVersion.mockResolvedValue(null);
    mockHasDocker.mockResolvedValue(false);

    const program = new Command();
    registerDoctor(program);

    await program.parseAsync(["node", "yavio", "doctor"]);

    const output = consoleLogs.join("\n");
    expect(output).toContain("Some critical checks failed");
  });
});
