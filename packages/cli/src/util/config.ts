import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CONFIG_FILENAME = ".yaviorc.json";

function globalDir(): string {
  return join(homedir(), ".yavio");
}

function globalConfigPath(): string {
  return join(globalDir(), "config.json");
}

export interface ProjectConfig {
  version: number;
  apiKey?: string;
  endpoint?: string;
}

export interface GlobalConfig {
  telemetry?: boolean;
  instanceId?: string;
}

/**
 * Walk up directories from `startDir` looking for `.yaviorc.json`.
 * Returns the path and parsed config, or null if not found.
 */
export function readConfig(startDir?: string): {
  path: string;
  config: ProjectConfig;
} | null {
  let dir = startDir ?? process.cwd();
  for (;;) {
    const filePath = join(dir, CONFIG_FILENAME);
    try {
      const content = readFileSync(filePath, "utf-8");
      return { path: filePath, config: JSON.parse(content) as ProjectConfig };
    } catch {
      // File not found — keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Write `.yaviorc.json` in the given directory.
 */
export function writeConfig(dir: string, data: ProjectConfig): string {
  const filePath = join(dir, CONFIG_FILENAME);
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  return filePath;
}

/**
 * Ensure `.yaviorc.json` is in `.gitignore`.
 * Creates `.gitignore` if it doesn't exist.
 */
export function ensureGitignore(dir: string): void {
  const gitignorePath = join(dir, ".gitignore");
  try {
    const content = readFileSync(gitignorePath, "utf-8");
    if (content.includes(CONFIG_FILENAME)) return;
    writeFileSync(gitignorePath, `${content.trimEnd()}\n${CONFIG_FILENAME}\n`, "utf-8");
  } catch {
    writeFileSync(gitignorePath, `${CONFIG_FILENAME}\n`, "utf-8");
  }
}

/**
 * Read global config from `~/.yavio/config.json`.
 */
export function readGlobalConfig(): GlobalConfig {
  try {
    const content = readFileSync(globalConfigPath(), "utf-8");
    return JSON.parse(content) as GlobalConfig;
  } catch {
    return {};
  }
}

/**
 * Write global config to `~/.yavio/config.json`.
 */
export function writeGlobalConfig(data: GlobalConfig): void {
  mkdirSync(globalDir(), { recursive: true });
  writeFileSync(globalConfigPath(), `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}
