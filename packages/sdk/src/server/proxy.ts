import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildConnectionEvent, buildToolCallEvent } from "../core/events.js";
import { generateSessionId, generateTraceId } from "../core/ids.js";
import { detectPlatform } from "../core/platform.js";
import type { SessionState, YavioConfig } from "../core/types.js";
import type { Transport } from "../transport/types.js";
import { type RequestStore, createYavioContext, runInContext } from "./context.js";

/**
 * Create a Proxy around McpServer that intercepts tool() and connect()
 * to inject Yavio instrumentation transparently.
 */
export function createProxy(
  server: McpServer,
  config: YavioConfig,
  transport: Transport,
  sdkVersion: string,
): McpServer {
  // Session state (set on connect, shared across all tool calls in this connection)
  let session: SessionState = {
    sessionId: generateSessionId(),
    userId: null,
    userTraits: {},
    platform: "unknown",
    stepSequence: 0,
  };

  const originalTool = server.tool.bind(server);
  const originalConnect = server.connect.bind(server);

  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "tool") {
        return (...args: unknown[]) => {
          // The callback is always the last argument
          const cbIndex = args.findIndex((a) => typeof a === "function");
          if (cbIndex === -1) {
            return (originalTool as (...a: unknown[]) => unknown)(...args);
          }

          const originalCb = args[cbIndex] as (...cbArgs: unknown[]) => unknown;
          const toolName = typeof args[0] === "string" ? args[0] : "unknown";

          // Replace callback with instrumented version
          args[cbIndex] = async (...cbArgs: unknown[]) => {
            // Lazy platform detection — clientInfo is available after initialize
            if (session.platform === "unknown") {
              try {
                const clientVersion = (
                  server.server as unknown as {
                    getClientVersion?: () => { name: string } | undefined;
                  }
                ).getClientVersion?.();
                if (clientVersion?.name) {
                  session.platform = detectPlatform({ clientName: clientVersion.name });
                }
              } catch {
                // Keep "unknown"
              }
            }

            const traceId = generateTraceId();
            const store: RequestStore = {
              traceId,
              session,
              transport,
              sdkVersion,
            };

            // Find the "extra" parameter — it's the last argument to the callback
            // For zero-arg tools it's the only arg, for schema tools it's the second
            const extra = cbArgs[cbArgs.length - 1];
            if (extra && typeof extra === "object") {
              (extra as Record<string, unknown>).yavio = createYavioContext(store);
            }

            const startTime = performance.now();
            try {
              const result = await runInContext(store, () => originalCb(...cbArgs));
              const latencyMs = Math.round(performance.now() - startTime);

              const toolCallEvent = buildToolCallEvent(
                {
                  traceId,
                  sessionId: session.sessionId,
                  userId: session.userId ?? undefined,
                  platform: session.platform,
                  sdkVersion,
                },
                {
                  toolName,
                  latencyMs,
                  status: "success",
                  inputKeys:
                    config.capture.inputValues && cbArgs[0] !== extra
                      ? extractInputKeys(cbArgs[0])
                      : undefined,
                  inputTypes:
                    config.capture.inputValues && cbArgs[0] !== extra
                      ? extractInputTypes(cbArgs[0])
                      : undefined,
                },
              );
              transport.send([toolCallEvent]);

              return result;
            } catch (error) {
              const latencyMs = Math.round(performance.now() - startTime);

              const toolCallEvent = buildToolCallEvent(
                {
                  traceId,
                  sessionId: session.sessionId,
                  userId: session.userId ?? undefined,
                  platform: session.platform,
                  sdkVersion,
                },
                {
                  toolName,
                  latencyMs,
                  status: "error",
                  errorCategory: "unknown",
                  errorMessage: error instanceof Error ? error.message : String(error),
                },
              );
              transport.send([toolCallEvent]);

              throw error;
            }
          };

          return (originalTool as (...a: unknown[]) => unknown)(...args);
        };
      }

      if (prop === "connect") {
        return async (mcpTransport: unknown) => {
          // Extract platform signals from the transport
          const transportObj = mcpTransport as Record<string, unknown>;
          const sessionIdFromTransport =
            typeof transportObj.sessionId === "string" ? transportObj.sessionId : undefined;

          session = {
            sessionId: sessionIdFromTransport ?? generateSessionId(),
            userId: null,
            userTraits: {},
            platform: detectPlatform({
              clientName: undefined, // filled in after initialize
            }),
            stepSequence: 0,
          };

          const result = await originalConnect(
            mcpTransport as Parameters<typeof originalConnect>[0],
          );

          // Emit connection event
          const connectionEvent = buildConnectionEvent(
            {
              traceId: generateTraceId(),
              sessionId: session.sessionId,
              platform: session.platform,
              sdkVersion,
            },
            {},
          );
          transport.send([connectionEvent]);

          return result;
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Extract top-level key names from tool args (values set to `true`). */
function extractInputKeys(args: unknown): Record<string, unknown> | undefined {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const keys: Record<string, unknown> = {};
    for (const key of Object.keys(args as Record<string, unknown>)) {
      keys[key] = true;
    }
    return keys;
  }
  return undefined;
}

/** Extract top-level key→typeof map from tool args. */
function extractInputTypes(args: unknown): Record<string, unknown> | undefined {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const types: Record<string, unknown> = {};
    for (const key of Object.keys(args as Record<string, unknown>)) {
      types[key] = typeof (args as Record<string, unknown>)[key];
    }
    return types;
  }
  return undefined;
}
