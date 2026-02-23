import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../core/config.js";

describe("resolveConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.YAVIO_API_KEY = undefined;
    process.env.YAVIO_ENDPOINT = undefined;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns null when no API key is found", () => {
    expect(resolveConfig()).toBeNull();
  });

  it("resolves from code options (highest priority)", () => {
    process.env.YAVIO_API_KEY = "env_key";
    const config = resolveConfig({ apiKey: "code_key" });
    expect(config?.apiKey).toBe("code_key");
  });

  it("falls back to env var for API key", () => {
    process.env.YAVIO_API_KEY = "env_key";
    const config = resolveConfig();
    expect(config?.apiKey).toBe("env_key");
  });

  it("resolves endpoint from code options", () => {
    const config = resolveConfig({
      apiKey: "test",
      endpoint: "http://localhost:3001/v1/events",
    });
    expect(config?.endpoint).toBe("http://localhost:3001/v1/events");
  });

  it("falls back to env var for endpoint", () => {
    process.env.YAVIO_ENDPOINT = "http://custom:3001/v1/events";
    const config = resolveConfig({ apiKey: "test" });
    expect(config?.endpoint).toBe("http://custom:3001/v1/events");
  });

  it("uses default endpoint when none specified", () => {
    const config = resolveConfig({ apiKey: "test" });
    expect(config?.endpoint).toBe("https://ingest.yavio.ai/v1/events");
  });

  it("uses default capture config", () => {
    const config = resolveConfig({ apiKey: "test" });
    expect(config?.capture).toEqual({
      inputValues: true,
      outputValues: true,
      geo: true,
      tokens: true,
      retries: true,
    });
  });

  it("merges partial capture options", () => {
    const config = resolveConfig({
      apiKey: "test",
      capture: { inputValues: false },
    });
    expect(config?.capture).toEqual({
      inputValues: false,
      outputValues: true,
      geo: true,
      tokens: true,
      retries: true,
    });
  });

  describe(".yaviorc.json file discovery", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "yavio-config-test-"));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("reads API key from .yaviorc.json", () => {
      writeFileSync(join(tempDir, ".yaviorc.json"), JSON.stringify({ apiKey: "file_key" }));
      const originalCwd = process.cwd;
      process.cwd = () => tempDir;
      try {
        const config = resolveConfig();
        expect(config?.apiKey).toBe("file_key");
      } finally {
        process.cwd = originalCwd;
      }
    });

    it("walks up directories to find config", () => {
      const childDir = join(tempDir, "nested", "deep");
      mkdirSync(childDir, { recursive: true });
      writeFileSync(join(tempDir, ".yaviorc.json"), JSON.stringify({ apiKey: "parent_key" }));
      const originalCwd = process.cwd;
      process.cwd = () => childDir;
      try {
        const config = resolveConfig();
        expect(config?.apiKey).toBe("parent_key");
      } finally {
        process.cwd = originalCwd;
      }
    });

    it("code options take priority over config file", () => {
      writeFileSync(join(tempDir, ".yaviorc.json"), JSON.stringify({ apiKey: "file_key" }));
      const originalCwd = process.cwd;
      process.cwd = () => tempDir;
      try {
        const config = resolveConfig({ apiKey: "code_key" });
        expect(config?.apiKey).toBe("code_key");
      } finally {
        process.cwd = originalCwd;
      }
    });

    it("ignores malformed .yaviorc.json without crashing", () => {
      writeFileSync(join(tempDir, ".yaviorc.json"), "{ not valid json !!! }");
      const originalCwd = process.cwd;
      process.cwd = () => tempDir;
      try {
        const config = resolveConfig();
        expect(config).toBeNull();
      } finally {
        process.cwd = originalCwd;
      }
    });
  });
});
