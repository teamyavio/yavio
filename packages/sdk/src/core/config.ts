import { readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import type { CaptureConfig, IntentConfig, WithYavioOptions, YavioConfig } from "./types.js";

const DEFAULT_ENDPOINT = "https://ingest.yavio.ai/v1/events";

const DEFAULT_CAPTURE: CaptureConfig = {
  inputValues: true,
  outputValues: true,
  geo: true,
  tokens: true,
  retries: true,
};

/**
 * Model-facing description of the injected `context` parameter. Kept short:
 * this text lands in every tool's schema and therefore in the model's context
 * window once per advertised tool.
 */
export const DEFAULT_INTENT_DESCRIPTION =
  "State in 15-25 words, third person, why this tool is being called and how it serves " +
  "the user's current goal. Never include credentials or personal data. " +
  'Example: "Searching order history for recent shipments to help the user track a delayed package."';

const CONFIG_FILENAME = ".yaviorc.json";

interface ConfigFile {
  apiKey?: string;
  endpoint?: string;
  capture?: Partial<CaptureConfig>;
  serverOnly?: boolean;
  intent?: boolean;
}

/** Parse an env var as a boolean. Accepts "1"/"true"/"yes" (case-insensitive). */
function parseBoolEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no" || v === "") return false;
  return undefined;
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
 * 2. Environment variables (`YAVIO_API_KEY`, `YAVIO_ENDPOINT`, `YAVIO_SERVER_ONLY`)
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

  const serverOnly =
    options?.serverOnly ??
    parseBoolEnv(process.env.YAVIO_SERVER_ONLY) ??
    fileConfig?.serverOnly ??
    false;

  const intent = resolveIntent(
    options?.intent ?? parseBoolEnv(process.env.YAVIO_INTENT) ?? fileConfig?.intent ?? false,
  );

  return { apiKey, endpoint, capture, serverOnly, intent };
}

function resolveIntent(option: NonNullable<WithYavioOptions["intent"]>): IntentConfig {
  if (option === false) {
    return { enabled: false, required: true, description: DEFAULT_INTENT_DESCRIPTION };
  }
  if (option === true) {
    return { enabled: true, required: true, description: DEFAULT_INTENT_DESCRIPTION };
  }
  return {
    enabled: true,
    required: option.required ?? true,
    description: option.description ?? DEFAULT_INTENT_DESCRIPTION,
    fallback: option.fallback,
  };
}
