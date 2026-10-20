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
import { createProxy, releaseConnectionMark } from "./proxy.js";
import { logOnce, sharedStateFor, shutdownShared } from "./shared.js";

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

function rejectUnsupported(server: unknown): void {
  logOnce(ErrorCode.SDK.UNSUPPORTED_SERVER, () => {
    const shape =
      server === null
        ? "null"
        : typeof server !== "object"
          ? typeof server
          : (server as { constructor?: { name?: string } }).constructor?.name || "object";
    console.error(
      `[${ErrorCode.SDK.UNSUPPORTED_SERVER}] withYavio() expects an McpServer (@modelcontextprotocol/sdk >=1.24.0 or @modelcontextprotocol/server 2.x) and got ${shape} without registerTool() — returned unwrapped, nothing is instrumented. Shown once per process.`,
    );
  });
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

/**
 * Create a Yavio client: the once-per-process half of the SDK (#133).
 *
 * Resolves the configuration once and binds to the process-level state for
 * it — the HTTP transport to ingest, the session store, the widget token
 * cache, the shutdown hooks — shared with every other client and
 * `withYavio()` call that resolves to the same endpoint and API key. `wrap()`
 * is then cheap enough to run on every request of a stateless host:
 *
 * ```ts
 * const yavio = createYavio({ serverOnly: true });
 * app.post("/mcp", async (req, res) => {
 *   const server = yavio.wrap(buildServer()); // a new McpServer per request
 *   …
 * });
 * ```
 *
 * If no API key is found, `wrap()` returns every server unchanged
 * (transparent no-op) and `shutdown()` does nothing.
 */
export function createYavio(options?: WithYavioOptions): YavioClient {
  const config = resolveConfig(options);

  if (!config) {
    console.warn(
      `[${ErrorCode.SDK.NO_API_KEY}] No API key found — Yavio SDK running in no-op mode`,
    );
    return {
      wrap: (server) => server,
      shutdown: async () => {},
    };
  }

  // From here on a `yavio.*` call outside a wrapped tool call is a dropped
  // event worth a warning (it is expected, and silent, in no-op mode).
  markSdkActive();
  logModes(config);

  // Created on first use and shared process-wide: one transport, one session
  // store, one token cache per (endpoint, apiKey), one signal handler pair.
  // Looked up per wrap (a Map read), so a wrap after shutdown() starts a
  // fresh transport instead of writing into a stopped one.
  const shared = () => sharedStateFor(config, SDK_VERSION, releaseConnectionMark);
  shared();

  return {
    wrap<T extends McpServerLike>(server: T): T {
      if (!isSupportedServer(server)) {
        rejectUnsupported(server);
        return server;
      }
      const state = shared();
      return createProxy(server, config, state.transport, SDK_VERSION, state);
    },
    shutdown: () => shutdownShared(config),
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
 * Safe to call once per request on a stateless host: the transport, the
 * session store and the shutdown hooks are shared per resolved configuration
 * (see `createYavio()`, which also resolves the configuration only once).
 */
export function withYavio<T extends McpServerLike>(server: T, options?: WithYavioOptions): T {
  // Before the configuration is resolved and anything is created: an
  // unsupported value must not cost a transport (YAVIO-1107).
  if (!isSupportedServer(server)) {
    rejectUnsupported(server);
    return server;
  }
  return createYavio(options).wrap(server);
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
