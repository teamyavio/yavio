import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureGitignore, readConfig, writeConfig } from "../util/config.js";

describe("config utilities", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "yavio-cli-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("readConfig", () => {
    it("finds .yaviorc.json in the given directory", () => {
      const config = { version: 1, apiKey: "yav_test123456" };
      writeFileSync(join(tempDir, ".yaviorc.json"), JSON.stringify(config));

      const result = readConfig(tempDir);
      expect(result).not.toBeNull();
      expect(result?.config.apiKey).toBe("yav_test123456");
      expect(result?.config.version).toBe(1);
    });

    it("walks up to find .yaviorc.json in parent directory", () => {
      const config = { version: 1, apiKey: "yav_parent12345" };
      writeFileSync(join(tempDir, ".yaviorc.json"), JSON.stringify(config));

      const childDir = join(tempDir, "child");
      mkdirSync(childDir);

      const result = readConfig(childDir);
      expect(result).not.toBeNull();
      expect(result?.config.apiKey).toBe("yav_parent12345");
    });

    it("returns null when no config file exists", () => {
      const result = readConfig(tempDir);
      expect(result).toBeNull();
    });

    it("returns null for invalid JSON", () => {
      writeFileSync(join(tempDir, ".yaviorc.json"), "not json");
      // JSON.parse will throw, caught by try/catch, walks up then returns null
      const result = readConfig(tempDir);
      // It may parse as far as the root, so it returns null
      expect(result).toBeNull();
    });
  });

  describe("writeConfig", () => {
    it("creates .yaviorc.json with the given data", () => {
      const data = { version: 1, apiKey: "yav_write123456" };
      const filePath = writeConfig(tempDir, data);

      expect(filePath).toBe(join(tempDir, ".yaviorc.json"));
      const content = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(content.apiKey).toBe("yav_write123456");
      expect(content.version).toBe(1);
    });
  });

  describe("ensureGitignore", () => {
    it("creates .gitignore with .yaviorc.json if it does not exist", () => {
      ensureGitignore(tempDir);
      const content = readFileSync(join(tempDir, ".gitignore"), "utf-8");
      expect(content).toContain(".yaviorc.json");
    });

    it("appends .yaviorc.json to existing .gitignore", () => {
      writeFileSync(join(tempDir, ".gitignore"), "node_modules\n");
      ensureGitignore(tempDir);
      const content = readFileSync(join(tempDir, ".gitignore"), "utf-8");
      expect(content).toContain("node_modules");
      expect(content).toContain(".yaviorc.json");
    });

    it("does not duplicate if .yaviorc.json already in .gitignore", () => {
      writeFileSync(join(tempDir, ".gitignore"), ".yaviorc.json\n");
      ensureGitignore(tempDir);
      const content = readFileSync(join(tempDir, ".gitignore"), "utf-8");
      const count = content.split(".yaviorc.json").length - 1;
      expect(count).toBe(1);
    });
  });
});
