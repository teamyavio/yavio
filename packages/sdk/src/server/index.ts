import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode } from "@yavio/shared/error-codes";
import { resolveConfig } from "../core/config.js";
import type { WithYavioOptions, YavioContext } from "../core/types.js";
import { HttpTransport } from "../transport/http.js";
import { createYavioContext } from "./context.js";
import { createProxy } from "./proxy.js";

export const SDK_VERSION = "0.0.1";

/**
 * Wrap an MCP server with Yavio instrumentation.
 *
 * Auto-captures tool calls and injects `ctx.yavio` into tool handlers
 * for explicit tracking (`.identify()`, `.step()`, `.track()`, `.conversion()`).
 *
 * If no API key is found, returns the original server unchanged (transparent no-op).
 */
export function withYavio<T extends McpServer>(server: T, options?: WithYavioOptions): T {
  const config = resolveConfig(options);

  if (!config) {
    console.warn(
      `[${ErrorCode.SDK.NO_API_KEY}] No API key found — Yavio SDK running in no-op mode`,
    );
    return server;
  }

  const transport = new HttpTransport({
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    sdkVersion: SDK_VERSION,
  });
  transport.start();

  // Shutdown hooks
  const shutdownHandler = () => {
    transport.shutdown().catch(() => {});
  };
  process.on("SIGTERM", shutdownHandler);
  process.on("SIGINT", shutdownHandler);

  return createProxy(server, config, transport, SDK_VERSION);
}

/**
 * Module singleton for tracking outside of tool handler context.
 *
 * When used inside a `runInContext()` scope (e.g., within a tool handler),
 * events are associated with the current trace and session.
 * When used outside context, calls are no-ops.
 */
export const yavio: YavioContext = createYavioContext();

export type { CaptureConfig, WithYavioOptions, YavioContext } from "../core/types.js";
