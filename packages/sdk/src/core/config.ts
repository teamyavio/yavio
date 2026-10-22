import { readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { ErrorCode } from "@yavio/shared/error-codes";
import type {
  CaptureConfig,
  IntentConfig,
  ShutdownTimeoutSource,
  ToolCaptureOverride,
  WithYavioOptions,
  YavioConfig,
} from "./types.js";

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
  // Off: a rejected call must not store what the schema refused (#123).
  rejectedInputValues: false,
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
 * "€2,500 monthly income" and "€10,000 investment" with that sentence in place.
 *
 * Be clear about what that does and does not imply. It says the model-level
 * deterrent was ineffective; it does NOT say the downstream layer covers the
 * gap. stripPii() matches five shapes (email, mod-97-valid IBAN, Luhn-valid card,
 * US SSN, US-format phone) and the clamp only bounds length, so the very examples above pass
 * through both untouched. Removing this clause traded a weak control for none,
 * and that is a real trade rather than a free one.
 *
 * So: a sentence here is welcome if it demonstrably improves what models write
 * — it is just not a control, and must not be described as one. The honest
 * answer for data that must not be stored is `intent: false`, which is what the
 * docs now tell customers.
 */
export const DEFAULT_INTENT_DESCRIPTION =
  "Why are you calling this tool? Briefly describe the user's goal.";

const CONFIG_FILENAME = ".yaviorc.json";

/**
 * The drain deadline when nothing configures one (#142): 4 s since #148,
 * so that a host which follows the README (a close bounded at 3 s, then
 * `shutdown()`) exits within the grace period of every common platform —
 * Fly.io kills 5 s after the signal, Cloud Run 10 s, Kubernetes and ECS
 * 30 s. On a signal this is the whole process budget, counted from the
 * signal; outside a signal it bounds each `shutdown()` from its call.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 4_000;
/**
 * The range `shutdownTimeoutMs` accepts (#142 review): below 100 ms a
 * seconds-for-milliseconds slip (`YAVIO_SHUTDOWN_TIMEOUT_MS=10`) would drop
 * nearly everything; above 2^31-1 Node clamps `setTimeout` to 1 ms with a
 * TimeoutOverflowWarning, so a "no deadline" value such as
 * `Number.MAX_SAFE_INTEGER` would do the same.
 */
export const MIN_SHUTDOWN_TIMEOUT_MS = 100;
export const MAX_SHUTDOWN_TIMEOUT_MS = 2_147_483_647;

interface ConfigFile {
  apiKey?: string;
  endpoint?: string;
  capture?: Partial<CaptureConfig>;
  serverOnly?: boolean;
  intent?: boolean;
  tools?: Record<string, ToolCaptureOverride>;
  shutdownTimeoutMs?: number;
}

const TOOL_OVERRIDE_KEYS = [
  "inputValues",
  "outputValues",
  "intent",
  "rejectedInputValues",
] as const;

/**
 * Merge per-tool overrides from the config file and the code options, field
 * by field per tool (code wins), the same way `capture` merges. Only the known
 * keys survive (an unknown key is ignored), and like the global flags they
 * fail closed: the file is hand-written JSON, and a `"false"` string must not
 * silently drop the override and leave the tool on the global default — it
 * becomes `false` with one warning.
 */
function resolveTools(
  ...sources: Array<Record<string, ToolCaptureOverride> | undefined>
): Record<string, ToolCaptureOverride> {
  // No prototype: a tool is looked up by its name, and a tool (or a JSON key)
  // called `__proto__` or `constructor` must be an ordinary entry, not the
  // object's prototype. Readers use Object.hasOwn for the same reason.
  const tools: Record<string, ToolCaptureOverride> = Object.create(null);
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const [name, override] of Object.entries(source)) {
      if (!override || typeof override !== "object") continue;
      const merged: ToolCaptureOverride = { ...(Object.hasOwn(tools, name) ? tools[name] : {}) };
      for (const key of TOOL_OVERRIDE_KEYS) {
        const value = (override as Record<string, unknown>)[key];
        if (value === undefined) continue;
        merged[key] = resolveBooleanFlag(`tools.${name}.${key}`, value);
      }
      if (Object.keys(merged).length > 0) tools[name] = merged;
    }
  }
  return tools;
}

const warnedInvalidFlags = new Set<string>();

/** @internal Reset the warn-once state — exposed for testing only. */
export function _resetConfigWarnings(): void {
  warnedInvalidFlags.clear();
}

/**
 * `capture` is spread from hand-written JSON and untyped JS, so a flag can be
 * anything — and `"false"` is truthy. A capture flag must fail closed: any
 * value it does not accept turns that capture off. Warn once per flag and
 * process; stateless servers resolve the config on every request.
 */
function warnInvalidFlag(path: string, accepted: string, value: unknown): void {
  if (warnedInvalidFlags.has(path)) return;
  warnedInvalidFlags.add(path);
  console.warn(
    `[${ErrorCode.SDK.INVALID_CAPTURE_OPTION}] ${path} must be ${accepted}, got ${JSON.stringify(value)} — treating it as false. Shown once per process.`,
  );
}

/** Why the last `resolveConfig()` returned null, for the caller's log line. */
let noopReason: "no-api-key" | "invalid-endpoint" | null = null;

/** The reason the last `resolveConfig()` call went no-op, if it did. */
export function lastNoopReason(): "no-api-key" | "invalid-endpoint" | null {
  return noopReason;
}

/**
 * The endpoint must be an http(s) URL: the transport and the widget-token
 * mint both build URLs from it, and `new URL("")` throws.
 *
 * Empty or whitespace-only means unset — what a compose file passes for an
 * unset `YAVIO_ENDPOINT=`, and `??` keeps it — and takes the default. Any
 * other value that is not an http(s) URL is an error (`YAVIO-1002`, once)
 * and the SDK goes no-op: a typo in a self-hosted endpoint
 * (`localhost:3001/v1/events` parses with protocol `localhost:`, `htps://`,
 * a missing scheme) must never reroute an integrator's events and API key
 * to the hosted service. Returns null for that case.
 */
function resolveEndpoint(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return DEFAULT_ENDPOINT;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return value;
  } catch {
    // Not a URL at all.
  }
  if (!warnedInvalidFlags.has("endpoint")) {
    warnedInvalidFlags.add("endpoint");
    console.error(
      `[${ErrorCode.SDK.INVALID_ENDPOINT_URL}] endpoint must be an http(s) URL, got ${JSON.stringify(value)} — Yavio SDK running in no-op mode (nothing is sent anywhere; the hosted default is not used for an explicit endpoint). Shown once per process.`,
    );
  }
  return null;
}

function resolveGeo(value: unknown): CaptureConfig["geo"] {
  if (value === true || value === false || value === "country" || value === "region") {
    return value;
  }
  warnInvalidFlag("capture.geo", 'true, false, "country" or "region"', value);
  return false;
}

const BOOLEAN_CAPTURE_FLAGS = [
  "inputValues",
  "outputValues",
  "tokens",
  "retries",
  "rejectedInputValues",
] as const;

/** `path` names the flag in the warning: `capture.inputValues`, `tools.book.intent`. */
function resolveBooleanFlag(path: string, value: unknown): boolean {
  if (typeof value === "boolean") return value;
  warnInvalidFlag(path, "true or false", value);
  return false;
}

/**
 * `shutdownTimeoutMs`: an integer number of milliseconds in
 * [`MIN_SHUTDOWN_TIMEOUT_MS`, `MAX_SHUTDOWN_TIMEOUT_MS`] — from code (a
 * number), the env var (a string of decimal digits) or the file (a number,
 * or the same string), tried in that order. An unset or empty value falls
 * through to the next source; anything else — a string `Number()` would
 * take, `0x2710` or `1e4`, included — is one `YAVIO-1006` warning and the
 * default, because a typo must not turn into a deadline that drops every
 * event on shutdown. Returns the source with the value: the signal drain
 * is bounded only by values that were set explicitly, so a rejected value
 * reports `"default"` like an unset one (#142 review round 3).
 */
function resolveShutdownTimeout(
  sources: ReadonlyArray<readonly [Exclude<ShutdownTimeoutSource, "default">, unknown]>,
): { ms: number; source: ShutdownTimeoutSource } {
  for (const [source, value] of sources) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    const ms =
      typeof value === "number"
        ? value
        : typeof value === "string" && /^\d+$/.test(value.trim())
          ? Number(value)
          : Number.NaN;
    if (Number.isInteger(ms) && ms >= MIN_SHUTDOWN_TIMEOUT_MS && ms <= MAX_SHUTDOWN_TIMEOUT_MS) {
      return { ms, source };
    }
    if (!warnedInvalidFlags.has("shutdownTimeoutMs")) {
      warnedInvalidFlags.add("shutdownTimeoutMs");
      console.warn(
        `[${ErrorCode.SDK.INVALID_CAPTURE_OPTION}] shutdownTimeoutMs must be an integer between ${MIN_SHUTDOWN_TIMEOUT_MS} and ${MAX_SHUTDOWN_TIMEOUT_MS} milliseconds, got ${JSON.stringify(value)} — using ${DEFAULT_SHUTDOWN_TIMEOUT_MS}. Shown once per process.`,
      );
    }
    return { ms: DEFAULT_SHUTDOWN_TIMEOUT_MS, source: "default" };
  }
  return { ms: DEFAULT_SHUTDOWN_TIMEOUT_MS, source: "default" };
}

/**
 * `YAVIO_SHUTDOWN_TIMEOUT_MS` as an explicit value, or undefined when it is
 * unset, empty or rejected (the rejection warned `YAVIO-1006` once). Read
 * again when a signal arrives: the env var counts towards the process
 * deadline even when no client or `withYavio()` call is live (#148).
 */
export function shutdownTimeoutFromEnv(): number | undefined {
  const { ms, source } = resolveShutdownTimeout([["env", process.env.YAVIO_SHUTDOWN_TIMEOUT_MS]]);
  return source === "default" ? undefined : ms;
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
 * 2. Environment variables (`YAVIO_API_KEY`, `YAVIO_ENDPOINT`, `YAVIO_SERVER_ONLY`,
 *    `YAVIO_INTENT`, `YAVIO_SHUTDOWN_TIMEOUT_MS`)
 * 3. `.yaviorc.json` config file (walked up from cwd)
 *
 * Returns null if no API key is found (triggers no-op mode).
 */
export function resolveConfig(options?: WithYavioOptions): YavioConfig | null {
  const fileConfig = findConfigFile(process.cwd());

  const apiKey = options?.apiKey ?? process.env.YAVIO_API_KEY ?? fileConfig?.apiKey;

  if (!apiKey) {
    noopReason = "no-api-key";
    return null;
  }
  noopReason = null;

  const endpoint = resolveEndpoint(
    options?.endpoint ?? process.env.YAVIO_ENDPOINT ?? fileConfig?.endpoint ?? DEFAULT_ENDPOINT,
  );
  if (endpoint === null) {
    noopReason = "invalid-endpoint";
    return null;
  }

  // A field set to undefined is "not set" — untyped JS and computed options
  // (`geo: flag ? "country" : undefined`) produce one routinely — so it must
  // not override the file's value or the default; a plain spread would.
  const capture: CaptureConfig = {
    ...DEFAULT_CAPTURE,
    ...defined(fileConfig?.capture),
    ...defined(options?.capture),
  };
  capture.geo = resolveGeo(capture.geo);
  for (const flag of BOOLEAN_CAPTURE_FLAGS) {
    capture[flag] = resolveBooleanFlag(`capture.${flag}`, capture[flag]);
  }

  const serverOnly =
    options?.serverOnly ??
    parseBoolEnv(process.env.YAVIO_SERVER_ONLY) ??
    fileConfig?.serverOnly ??
    false;

  const intent = resolveIntent(
    options?.intent ?? parseBoolEnv(process.env.YAVIO_INTENT) ?? fileConfig?.intent ?? false,
  );

  // No env-var form: the shape is nested. File first, code options win.
  const tools = resolveTools(fileConfig?.tools, options?.tools);

  const { ms: shutdownTimeoutMs, source: shutdownTimeoutMsSource } = resolveShutdownTimeout([
    ["option", options?.shutdownTimeoutMs],
    ["env", process.env.YAVIO_SHUTDOWN_TIMEOUT_MS],
    ["file", fileConfig?.shutdownTimeoutMs],
  ]);

  return {
    apiKey,
    endpoint,
    capture,
    serverOnly,
    intent,
    tools,
    shutdownTimeoutMs,
    shutdownTimeoutMsSource,
  };
}

/** The entries of `source` whose value is not undefined. */
function defined<T extends object>(source: T | undefined): Partial<T> {
  if (!source || typeof source !== "object") return {};
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
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
