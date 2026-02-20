import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

describe("docker utilities", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "yavio-docker-test-")));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("resolveComposeFile", () => {
    it("returns the file path when --file flag points to existing file", async () => {
      const { resolveComposeFile } = await import("../util/docker.js");
      const composePath = join(tempDir, "docker-compose.yml");
      writeFileSync(composePath, "services: {}");

      const result = resolveComposeFile(composePath);
      expect(result).toBe(composePath);
    });

    it("throws when --file flag points to non-existent file", async () => {
      const { resolveComposeFile } = await import("../util/docker.js");
      expect(() => resolveComposeFile("/nonexistent/docker-compose.yml")).toThrow(
        "Compose file not found",
      );
    });

    it("throws when no compose file is found in cwd", async () => {
      const { resolveComposeFile } = await import("../util/docker.js");
      const originalCwd = process.cwd();
      process.chdir(tempDir);
      try {
        expect(() => resolveComposeFile()).toThrow("No docker-compose.yml found");
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("resolves docker-compose.yml from cwd", async () => {
      const { resolveComposeFile } = await import("../util/docker.js");
      const composePath = join(tempDir, "docker-compose.yml");
      writeFileSync(composePath, "services: {}");

      const originalCwd = process.cwd();
      process.chdir(tempDir);
      try {
        const result = resolveComposeFile();
        expect(result).toBe(composePath);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe("hasDocker / hasDockerCompose", () => {
    it("returns true when docker is available", async () => {
      const { execa } = await import("execa");
      const mockedExeca = vi.mocked(execa);
      mockedExeca.mockResolvedValueOnce({ stdout: "Docker version 27.0.1" } as never);

      const { hasDocker } = await import("../util/docker.js");
      const result = await hasDocker();
      expect(result).toBe(true);
    });

    it("returns false when docker is not available", async () => {
      const { execa } = await import("execa");
      const mockedExeca = vi.mocked(execa);
      mockedExeca.mockRejectedValueOnce(new Error("not found"));

      const { hasDocker } = await import("../util/docker.js");
      const result = await hasDocker();
      expect(result).toBe(false);
    });
  });

  describe("getDockerVersion", () => {
    it("parses version string", async () => {
      const { execa } = await import("execa");
      const mockedExeca = vi.mocked(execa);
      mockedExeca.mockResolvedValueOnce({
        stdout: "Docker version 27.0.1, build abcdef",
      } as never);

      const { getDockerVersion } = await import("../util/docker.js");
      const version = await getDockerVersion();
      expect(version).toBe("27.0.1");
    });

    it("returns null on failure", async () => {
      const { execa } = await import("execa");
      const mockedExeca = vi.mocked(execa);
      mockedExeca.mockRejectedValueOnce(new Error("not found"));

      const { getDockerVersion } = await import("../util/docker.js");
      const version = await getDockerVersion();
      expect(version).toBeNull();
    });
  });

  describe("getComposeProjectName", () => {
    it("derives project name from compose file directory", async () => {
      const { getComposeProjectName } = await import("../util/docker.js");
      const composePath = join(tempDir, "docker-compose.yml");
      writeFileSync(composePath, "services: {}");

      const name = getComposeProjectName(composePath);
      // basename of tempDir, lowercased and stripped of non-alphanumeric
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
      expect(name).toMatch(/^[a-z0-9_-]+$/);
    });
  });

  describe("getComposeVersion", () => {
    it("parses compose version string", async () => {
      const { execa } = await import("execa");
      const mockedExeca = vi.mocked(execa);
      mockedExeca.mockResolvedValueOnce({
        stdout: "Docker Compose version v2.28.0",
      } as never);

      const { getComposeVersion } = await import("../util/docker.js");
      const version = await getComposeVersion();
      expect(version).toBe("2.28.0");
    });
  });
});
