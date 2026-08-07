import { readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import type { CaptureConfig, IntentConfig, WithYavioOptions, YavioConfig } from "./types.js";

// This hostname MUST resolve. The SDK swallows transport errors by design, so a
// dead default does not surface as an error to the integrator — it silently
// drops every event. It pointed at an unregistered host until 2026-08-04.
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
 *
 * CHANGED 2026-08-07 to PostHog's phrasing, verbatim
 * (https://posthog.com/docs/mcp-analytics/intent), after reading what the
 * previous wording actually produced.
 *
 * That wording prescribed a word count, third person AND a worked example — so
 * the model copied the example's shape. Of 59 intents captured on a live
 * comparison-shopping server, the ChatGPT ones averaged 122 characters and
 * nearly every one opened "Comparing X to help the user Y": informative, but
 * interchangeable, which defeats the point of a free-text field. One
 * unconstrained question leaves room for the model to say something specific.
 *
 * Note what is deliberately NOT here: the old "Never include credentials or
 * personal data" clause. It was not doing the job — captured intents contained
 * "€2,500 monthly income" and "€10,000 investment" with that sentence in
 * place — and a description the model reinterprets is the wrong layer for a
 * privacy guarantee. The real guarantees are downstream and unconditional:
 * stripPii() over intent_signals in buildToolCallEvent, and the 500-character
 * clamp in MAX_INTENT_LENGTH. Do not re-add a privacy sentence here expecting
 * it to enforce anything.
 */
export const DEFAULT_INTENT_DESCRIPTION =
  "Why are you calling this tool? Briefly describe the user's goal.";

const CONFIG_FILENAME = ".yaviorc.json";

interface ConfigFile {
  apiKey?: string;
  endpoint?: string;
  capture?: Partial<CaptureConfig>;
  serverOnly?: boolean;
  intent?: boolean;
}

/**
 * Parse an env var as a boolean. Accepts "1"/"true"/"yes"/"on" (and their
 * negatives), case-insensitive. An empty or unrecognised value yields
 * undefined so the next configuration source still applies — an env var set
 * to "" (a common container default) must not silently override a config file.
 */
function parseBoolEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
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
