import { readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import type { CaptureConfig, WithYavioOptions, YavioConfig } from "./types.js";

const DEFAULT_ENDPOINT = "https://ingest.yavio.ai/v1/events";

const DEFAULT_CAPTURE: CaptureConfig = {
  inputValues: true,
  outputValues: true,
  geo: true,
  tokens: true,
  retries: true,
};

const CONFIG_FILENAME = ".yaviorc.json";

interface ConfigFile {
  apiKey?: string;
  endpoint?: string;
  capture?: Partial<CaptureConfig>;
}

/**
 * Walk up directories from `startDir` looking for `.yaviorc.json`.
 * Returns the parsed config or null.
 */
function findConfigFile(startDir: string): ConfigFile | null {
  let dir = startDir;
  for (;;) {
    try {
      const content = readFileSync(join(dir, CONFIG_FILENAME), "utf-8");
      return JSON.parse(content) as ConfigFile;
    } catch {
      // File not found or unreadable — keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Resolve SDK configuration with priority:
 * 1. Code options passed to `withYavio()`
 * 2. Environment variables (`YAVIO_API_KEY`, `YAVIO_ENDPOINT`)
 * 3. `.yaviorc.json` config file (walked up from cwd)
 *
 * Returns null if no API key is found (triggers no-op mode).
 */
export function resolveConfig(options?: WithYavioOptions): YavioConfig | null {
  const fileConfig = findConfigFile(process.cwd());

  const apiKey = options?.apiKey ?? process.env.YAVIO_API_KEY ?? fileConfig?.apiKey;

  if (!apiKey) return null;

  const endpoint =
    options?.endpoint ?? process.env.YAVIO_ENDPOINT ?? fileConfig?.endpoint ?? DEFAULT_ENDPOINT;

  const capture: CaptureConfig = {
    ...DEFAULT_CAPTURE,
    ...fileConfig?.capture,
    ...options?.capture,
  };

  return { apiKey, endpoint, capture };
}
