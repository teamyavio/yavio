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

    it("returns null when version format is unrecognized", async () => {
      const { execa } = await import("execa");
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: "Docker Compose unknown",
      } as never);

      const { getComposeVersion } = await import("../util/docker.js");
      const version = await getComposeVersion();
      expect(version).toBeNull();
    });

    it("returns null on failure", async () => {
      const { execa } = await import("execa");
      vi.mocked(execa).mockRejectedValueOnce(new Error("not found"));

      const { getComposeVersion } = await import("../util/docker.js");
      const version = await getComposeVersion();
      expect(version).toBeNull();
    });
  });

  describe("hasDockerCompose", () => {
    it("returns true when docker compose is available", async () => {
      const { execa } = await import("execa");
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: "Docker Compose version v2.28.0",
      } as never);

      const { hasDockerCompose } = await import("../util/docker.js");
      expect(await hasDockerCompose()).toBe(true);
    });

    it("returns false when docker compose is not available", async () => {
      const { execa } = await import("execa");
      vi.mocked(execa).mockRejectedValueOnce(new Error("not found"));

      const { hasDockerCompose } = await import("../util/docker.js");
      expect(await hasDockerCompose()).toBe(false);
    });
  });

  describe("removeVolumes", () => {
    it("calls docker volume rm with volume names", async () => {
      const { execa } = await import("execa");
      vi.mocked(execa).mockResolvedValueOnce({} as never);

      const { removeVolumes } = await import("../util/docker.js");
      await removeVolumes(["vol1", "vol2"]);

      expect(execa).toHaveBeenCalledWith("docker", ["volume", "rm", "--force", "vol1", "vol2"]);
    });

    it("does nothing for empty array", async () => {
      const { execa } = await import("execa");

      const { removeVolumes } = await import("../util/docker.js");
      await removeVolumes([]);

      expect(execa).not.toHaveBeenCalled();
    });
  });

  describe("getContainerStatus", () => {
    it("parses container JSON output", async () => {
      const { execa } = await import("execa");
      const composePath = join(tempDir, "docker-compose.yml");
      writeFileSync(composePath, "services: {}");
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: '{"Name":"c1","Service":"web","State":"running","Status":"Up","Health":"healthy"}',
      } as never);

      const { getContainerStatus } = await import("../util/docker.js");
      const result = await getContainerStatus(composePath);
      expect(result).toHaveLength(1);
      expect(result[0].Service).toBe("web");
    });

    it("returns empty array on empty stdout", async () => {
      const { execa } = await import("execa");
      const composePath = join(tempDir, "docker-compose.yml");
      writeFileSync(composePath, "services: {}");
      vi.mocked(execa).mockResolvedValueOnce({ stdout: "" } as never);

      const { getContainerStatus } = await import("../util/docker.js");
      const result = await getContainerStatus(composePath);
      expect(result).toEqual([]);
    });

    it("returns empty array on failure", async () => {
      const { getContainerStatus } = await import("../util/docker.js");
      const result = await getContainerStatus("/nonexistent/compose.yml");
      expect(result).toEqual([]);
    });
  });

  describe("execCompose", () => {
    it("uses files array when provided", async () => {
      const { execa } = await import("execa");
      const composePath = join(tempDir, "docker-compose.yml");
      writeFileSync(composePath, "services: {}");
      vi.mocked(execa).mockResolvedValueOnce({ stdout: "", stderr: "" } as never);

      const { execCompose } = await import("../util/docker.js");
      await execCompose(["up", "-d"], { files: [composePath] });

      expect(execa).toHaveBeenCalledWith("docker", ["compose", "-f", composePath, "up", "-d"], {
        stdio: "pipe",
      });
    });

    it("passes stdio option through", async () => {
      const { execa } = await import("execa");
      const composePath = join(tempDir, "docker-compose.yml");
      writeFileSync(composePath, "services: {}");
      vi.mocked(execa).mockResolvedValueOnce({ stdout: "", stderr: "" } as never);

      const { execCompose } = await import("../util/docker.js");
      await execCompose(["logs"], { files: [composePath], stdio: "inherit" });

      expect(execa).toHaveBeenCalledWith("docker", ["compose", "-f", composePath, "logs"], {
        stdio: "inherit",
      });
    });
  });

  describe("getDockerVersion (extended)", () => {
    it("returns null when version format is unrecognized", async () => {
      const { execa } = await import("execa");
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: "Docker unknown format",
      } as never);

      const { getDockerVersion } = await import("../util/docker.js");
      const version = await getDockerVersion();
      expect(version).toBeNull();
    });
  });
});
