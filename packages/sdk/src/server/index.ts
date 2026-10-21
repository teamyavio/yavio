import { ErrorCode } from "@yavio/shared/error-codes";
import { resolveConfig } from "../core/config.js";
import type {
  McpServerLike,
  WithYavioOptions,
  YavioClient,
  YavioConfig,
  YavioContext,
} from "../core/types.js";
import { SDK_VERSION } from "../core/version.js";
import { createYavioContext, markSdkActive } from "./context.js";
import { createProxy, existingProxy, releaseConnectionMark } from "./proxy.js";
import {
  type SharedHold,
  type SharedState,
  acquireShared,
  isLiveHold,
  logOnce,
  pinShared,
  releaseShared,
} from "./shared.js";

// Sent on every event batch. Defined in core/version.ts so the server and React
// bundles cannot drift apart at release time. Imported as well as re-exported
// because this module uses the value itself.
export { SDK_VERSION };

/**
 * Can this value be instrumented? MCP SDK v1 and v2 `McpServer` both register
 * tools through `registerTool()`; a transport, a handler or a framework facade
 * does not. Decided before any side effect, so an unsupported value costs
 * nothing: no transport, no listeners, no log besides the one error.
 */
function isSupportedServer(server: unknown): server is McpServerLike {
  return (
    typeof server === "object" &&
    server !== null &&
    typeof (server as { registerTool?: unknown }).registerTool === "function"
  );
}

/** The two entry points, named in messages so a log line says which one was called. */
type EntryPoint = "withYavio()" | "createYavio().wrap()";

function rejectUnsupported(server: unknown, entry: EntryPoint): void {
  logOnce(ErrorCode.SDK.UNSUPPORTED_SERVER, () => {
    const shape =
      server === null
        ? "null"
        : typeof server !== "object"
          ? typeof server
          : (server as { constructor?: { name?: string } }).constructor?.name || "object";
    console.error(
      `[${ErrorCode.SDK.UNSUPPORTED_SERVER}] ${entry} expects an McpServer (@modelcontextprotocol/sdk >=1.24.0 or @modelcontextprotocol/server 2.x) and got ${shape} without registerTool() — returned unwrapped, nothing is instrumented. Shown once per process.`,
    );
  });
}

/** Once per process, however many requests a stateless host wraps on. */
function warnNoApiKey(): void {
  logOnce(ErrorCode.SDK.NO_API_KEY, () =>
    console.warn(
      `[${ErrorCode.SDK.NO_API_KEY}] No API key found — Yavio SDK running in no-op mode`,
    ),
  );
}

/** Process-level log lines, once per process whatever the host's request rate. */
function logModes(config: YavioConfig): void {
  if (config.serverOnly) {
    logOnce("server-only", () =>
      console.info(
        "[yavio] Server-only mode: skipping _meta.yavio injection and widget token minting. The React widget will not auto-connect.",
      ),
    );
  }

  if (config.intent.enabled) {
    // `required` is independently configurable; the log must not claim
    // "required" for a server that was explicitly configured optional.
    logOnce(`intent:${config.intent.required}`, () =>
      console.info(
        config.intent.required
          ? "[yavio] Intent capture enabled: tools advertise a 'context' parameter — required on model-facing tools, optional on widget-invoked ones (pass intent: false to disable)."
          : "[yavio] Intent capture enabled: tools advertise an optional 'context' parameter on every tool (pass intent: false to disable).",
      ),
    );
  }
}

/** The session LRU's eviction hook: forget the conversation's connection-event mark. */
const evictionHookFor =
  (config: YavioConfig) =>
  (sessionId: string): void =>
    releaseConnectionMark(config.apiKey, sessionId);

/**
 * Wrap one server. A server that is already wrapped — or a proxy itself —
 * comes back as the existing proxy: a host that wraps the same long-lived
 * server on every request must not stack a callback wrapper per request
 * (N wraps, N `tool_call` events per call). The first wrap wins: a later
 * call with another endpoint or key, or one that would instrument the
 * pre-registered tools where the first did not, gets the existing proxy and
 * one `YAVIO-1108` warning per process.
 */
function wrapServer<T extends McpServerLike>(
  server: T,
  config: YavioConfig,
  state: SharedState,
  instrumentExisting: boolean,
  entry: EntryPoint,
): T {
  if (!isSupportedServer(server)) {
    rejectUnsupported(server, entry);
    return server;
  }
  const existing = existingProxy(server);
  if (existing) {
    const differs =
      existing.endpoint !== config.endpoint ||
      existing.apiKey !== config.apiKey ||
      (instrumentExisting && !existing.instrumentExisting);
    if (differs) {
      logOnce(ErrorCode.SDK.REWRAP_OPTIONS_IGNORED, () =>
        console.warn(
          `[${ErrorCode.SDK.REWRAP_OPTIONS_IGNORED}] ${entry} called on a server that is already wrapped with other options — the first wrap wins: its endpoint and API key stay, and tools registered before that first wrap are instrumented only if it was createYavio().wrap(). Returned the existing proxy. Shown once per process.`,
        ),
      );
    } else {
      logOnce("rewrap", () =>
        console.debug(
          `[yavio] ${entry} called on a server that is already wrapped — returning the existing proxy. Shown once per process.`,
        ),
      );
    }
    return existing.proxy;
  }
  return createProxy(server, config, state.transport, SDK_VERSION, state, { instrumentExisting });
}

/**
 * Create a Yavio client: the once-per-process half of the SDK (#133).
 *
 * Resolves the configuration once and holds the process-level state for it —
 * the HTTP transport to ingest, the session store, the shutdown hooks —
 * shared with every other client and `withYavio()` call that resolves to the
 * same endpoint and API key. `wrap()` is then cheap enough to run on every
 * request of a stateless host:
 *
 * ```ts
 * const analytics = createYavio({ serverOnly: true });
 * app.post("/mcp", async (req, res) => {
 *   const server = analytics.wrap(buildServer()); // a new McpServer per request
 *   …
 * });
 * ```
 *
 * `wrap()` instruments every tool on the server, including the ones
 * `buildServer()` registered before the wrap — unlike `withYavio()`, which
 * tracks only tools registered through the proxy it returns. A server that
 * is already wrapped comes back as its existing proxy: the first wrap wins,
 * later options are ignored (`YAVIO-1108` once when they differ).
 *
 * If no API key is found, `wrap()` returns every server unchanged
 * (transparent no-op) and `shutdown()` does nothing.
 */
export function createYavio(options?: WithYavioOptions): YavioClient {
  const config = resolveConfig(options);

  if (!config) {
    warnNoApiKey();
    return {
      wrap: (server) => server,
      shutdown: async () => {},
    };
  }

  // From here on a `yavio.*` call outside a wrapped tool call is a dropped
  // event worth a warning (it is expected, and silent, in no-op mode).
  markSdkActive();
  logModes(config);

  // This client's hold on the shared transport: taken on creation, released
  // by shutdown(), taken again by a wrap after shutdown() — or after a signal
  // drained everything — which then finds the transport other holders kept
  // alive, or starts a fresh one. A hold names the transport's generation, so
  // a stale hold never counts against a successor.
  const onEvict = evictionHookFor(config);
  let hold: SharedHold | null = null;
  const state = (): SharedState => {
    if (hold && isLiveHold(config, hold)) return hold.state;
    hold = acquireShared(config, SDK_VERSION, onEvict);
    return hold.state;
  };
  state();

  return {
    wrap: <T extends McpServerLike>(server: T): T =>
      wrapServer(server, config, state(), true, "createYavio().wrap()"),
    shutdown: async () => {
      if (!hold) return;
      const released = hold;
      hold = null;
      await releaseShared(config, released);
    },
  };
}

/**
 * Wrap an MCP server with Yavio instrumentation.
 *
 * Auto-captures tool calls and provides explicit tracking via the `yavio` singleton
 * (`.identify()`, `.step()`, `.track()`, `.conversion()`).
 *
 * If no API key is found, returns the original server unchanged (transparent no-op).
 *
 * Tracks the tools registered through the proxy it returns; a tool registered
 * on the server before the wrap stays untracked (`createYavio().wrap()` is
 * the entry point that instruments those). Safe for a server created per
 * request on a stateless host: the transport, the session store and the
 * shutdown hooks are shared per API key and endpoint, and never stopped
 * before the process exits. Wrapping the same long-lived server again returns
 * the existing proxy.
 */
export function withYavio<T extends McpServerLike>(server: T, options?: WithYavioOptions): T {
  // Before the configuration is resolved and anything is created: an
  // unsupported value must not cost a transport (YAVIO-1107).
  if (!isSupportedServer(server)) {
    rejectUnsupported(server, "withYavio()");
    return server;
  }
  const config = resolveConfig(options);
  if (!config) {
    warnNoApiKey();
    return server;
  }
  markSdkActive();
  logModes(config);
  return wrapServer(
    server,
    config,
    pinShared(config, SDK_VERSION, evictionHookFor(config)),
    false,
    "withYavio()",
  );
}

/**
 * Module singleton for explicit tracking inside tool handlers.
 *
 * Import this and call `yavio.identify()`, `yavio.track()`, etc. from within
 * any tool handler wrapped by `withYavio()`. Uses `AsyncLocalStorage` to
 * associate events with the current trace and session automatically.
 *
 * A call outside a wrapped tool call has no trace or session to attach to and
 * is dropped, with a single `YAVIO-1105` warning per process (none in no-op
 * mode). To keep a tool with sensitive input on the wrapped server, use the
 * `tools` overrides instead of registering it on the unwrapped one.
 */
export const yavio: YavioContext = createYavioContext();

export type {
  CaptureConfig,
  IntentOptions,
  McpServerLike,
  ToolCaptureOverride,
  WithYavioOptions,
  YavioClient,
  YavioContext,
} from "../core/types.js";
export { platformValues } from "../core/platform.js";
export type { Platform } from "../core/platform.js";
