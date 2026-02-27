import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildConnectionEvent,
  buildToolCallEvent,
  buildToolDiscoveryEvent,
} from "../core/events.js";
import { deriveSessionId, generateSessionId, generateTraceId } from "../core/ids.js";
import { detectPlatform } from "../core/platform.js";
import type { SessionState, YavioConfig } from "../core/types.js";
import type { Transport } from "../transport/types.js";
import { type RequestStore, runInContext } from "./context.js";
import { type MintResult, mintWidgetToken } from "./token.js";

/** Cached widget token with parsed expiry for reuse across tool calls. */
interface CachedWidgetToken {
  token: string;
  expiresAt: number;
}

function isMintResult(result: unknown): result is MintResult {
  return result !== null && typeof result === "object" && "token" in result;
}

/**
 * Get a widget token, reusing a cached one if still valid (30s buffer).
 * Invalidates cache on 401/403 (key rotation, revocation).
 * Returns null if minting fails — callers should skip injection silently.
 */
async function getWidgetToken(
  cache: { current: CachedWidgetToken | null },
  config: YavioConfig,
  traceId: string,
  sessionId: string,
): Promise<string | null> {
  if (cache.current && Date.now() < cache.current.expiresAt - 30_000) {
    return cache.current.token;
  }
  const result = await mintWidgetToken(config.endpoint, config.apiKey, traceId, sessionId);
  if (isMintResult(result)) {
    cache.current = { token: result.token, expiresAt: Date.parse(result.expiresAt) };
    return result.token;
  }
  // Auth failure — invalidate any stale cached token
  if (result && "status" in result && (result.status === 401 || result.status === 403)) {
    cache.current = null;
  }
  return null;
}

/**
 * Wrap a tool callback with Yavio instrumentation.
 *
 * Handles lazy platform detection, trace/session context,
 * latency measurement, and tool_call event emission.
 */
function wrapToolCallback(
  originalCb: (...cbArgs: unknown[]) => unknown,
  toolName: string,
  resolveSession: (sessionKey?: string) => SessionState,
  server: McpServer,
  config: YavioConfig,
  transport: Transport,
  sdkVersion: string,
  tokenCache: { current: CachedWidgetToken | null },
): (...cbArgs: unknown[]) => Promise<unknown> {
  return async (...cbArgs: unknown[]) => {
    // Extract MCP session ID from the extra parameter (RequestHandlerExtra.sessionId)
    // This is the most reliable correlation signal — set from the Mcp-Session-Id header
    const extra = cbArgs[cbArgs.length - 1];
    const mcpSessionId =
      extra && typeof extra === "object" ? (extra as Record<string, unknown>).sessionId : undefined;

    // Fall back to OpenAI's conversation-scoped session from _meta
    // OpenAI re-initializes MCP per tool call but sends a stable "openai/session" in _meta
    const extraMeta =
      extra && typeof extra === "object" ? (extra as Record<string, unknown>)._meta : undefined;
    const openaiSessionId =
      extraMeta && typeof extraMeta === "object"
        ? (extraMeta as Record<string, unknown>)["openai/session"]
        : undefined;

    const sessionKey =
      typeof mcpSessionId === "string"
        ? mcpSessionId
        : typeof openaiSessionId === "string"
          ? openaiSessionId
          : undefined;
    const session = resolveSession(sessionKey);

    // Emit deferred connection event on the first tool call for this session.
    // Deferred from connect() so that OpenAI's per-tool-call reconnects don't
    // spam a connection event for every tool call in the same conversation.
    if (!emittedConnections.has(session.sessionId)) {
      emittedConnections.add(session.sessionId);
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
    }

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

    const startTime = performance.now();
    try {
      const result = await runInContext(store, () => originalCb(...cbArgs));
      const latencyMs = Math.round(performance.now() - startTime);

      const captureInput = config.capture.inputValues && cbArgs[0] !== extra;
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
          inputKeys: captureInput ? extractInputKeys(cbArgs[0]) : undefined,
          inputTypes: captureInput ? extractInputTypes(cbArgs[0]) : undefined,
          inputValues: captureInput ? extractInputValues(cbArgs[0], extra) : undefined,
          outputContent: config.capture.outputValues ? extractOutputContent(result) : undefined,
        },
      );
      transport.send([toolCallEvent]);

      if (result && typeof result === "object") {
        try {
          const token = await getWidgetToken(
            tokenCache,
            config,
            store.traceId,
            store.session.sessionId,
          );
          if (token) {
            const res = result as Record<string, unknown>;
            if (!res._meta || typeof res._meta !== "object") {
              res._meta = {};
            }
            (res._meta as Record<string, unknown>).yavio = {
              token,
              endpoint: config.endpoint,
              traceId: store.traceId,
              sessionId: store.session.sessionId,
            };
          }
        } catch {
          // Widget token minting failed — don't break the tool call
        }
      }

      return result;
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startTime);

      const captureInputOnError = config.capture.inputValues && cbArgs[0] !== extra;
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
          inputValues: captureInputOnError ? extractInputValues(cbArgs[0], extra) : undefined,
        },
      );
      transport.send([toolCallEvent]);

      throw error;
    }
  };
}

/** Tracks session IDs that have already emitted a connection event. */
const emittedConnections = new Set<string>();

/** Tracks tool names that have already emitted a tool_discovery event (global dedup). */
const emittedToolDiscoveries = new Set<string>();

/** @internal Reset global dedup state — exposed for testing only. */
export function _resetGlobalState(): void {
  emittedConnections.clear();
  emittedToolDiscoveries.clear();
}

/**
 * Create a Proxy around McpServer that intercepts tool()/registerTool() and connect()
 * to inject Yavio instrumentation transparently.
 */
export function createProxy<T extends McpServer>(
  server: T,
  config: YavioConfig,
  transport: Transport,
  sdkVersion: string,
): T {
  // Session state (set on connect, shared across all tool calls in this connection)
  let session: SessionState = {
    sessionId: generateSessionId(),
    userId: null,
    userTraits: {},
    platform: "unknown",
    stepSequence: 0,
  };

  // Widget token cache — shared across tool calls, reset on reconnect
  const tokenCache: { current: CachedWidgetToken | null } = { current: null };

  // Reference to the current MCP transport for lazy sessionId lookup
  let currentMcpTransport: Record<string, unknown> | null = null;

  /**
   * Resolve the session for the current tool call.
   *
   * If a session key is available (MCP session ID, OpenAI session, or transport
   * session ID), derives a deterministic Yavio session ID from it so that any
   * server instance processing the same key produces the same ID.
   */
  const resolveSession = (sessionKey?: string) => {
    const key =
      sessionKey ??
      (currentMcpTransport && typeof currentMcpTransport.sessionId === "string"
        ? (currentMcpTransport.sessionId as string)
        : undefined);

    if (key) {
      session.sessionId = deriveSessionId(key);
    }
    return session;
  };

  const originalTool = server.tool.bind(server);
  const originalRegisterTool = server.registerTool.bind(server);
  const originalConnect = server.connect.bind(server);

  /** Emit a tool_discovery event via the transport. */
  const emitDiscovery = (
    toolName: string,
    description: string | undefined,
    inputSchema: Record<string, unknown> | undefined,
  ) => {
    transport.send([
      buildToolDiscoveryEvent(
        {
          traceId: generateTraceId(),
          sessionId: session.sessionId,
          sdkVersion,
          platform: session.platform,
        },
        { toolName, description, inputSchema },
      ),
    ]);
  };

  return new Proxy<T>(server, {
    get(target, prop, receiver) {
      if (prop === "tool") {
        return (...args: unknown[]) => {
          const cbIndex = args.findIndex((a) => typeof a === "function");
          if (cbIndex === -1) {
            return (originalTool as (...a: unknown[]) => unknown)(...args);
          }

          const originalCb = args[cbIndex] as (...cbArgs: unknown[]) => unknown;
          const toolName = typeof args[0] === "string" ? args[0] : "unknown";
          args[cbIndex] = wrapToolCallback(
            originalCb,
            toolName,
            resolveSession,
            server,
            config,
            transport,
            sdkVersion,
            tokenCache,
          );

          const result = (originalTool as (...a: unknown[]) => unknown)(...args);

          // Emit tool_discovery event (once per tool name)
          if (!emittedToolDiscoveries.has(toolName)) {
            emittedToolDiscoveries.add(toolName);
            let description: string | undefined;
            let inputSchema: Record<string, unknown> | undefined;
            // Scan args between name and callback for description + schema
            for (let i = 1; i < cbIndex; i++) {
              const arg = args[i];
              if (typeof arg === "string" && !description) {
                description = arg;
              } else if (typeof arg === "object" && arg !== null) {
                const schema = extractParamKeys(arg);
                if (schema) {
                  inputSchema = schema;
                } else if (!description) {
                  const obj = arg as Record<string, unknown>;
                  if (typeof obj.description === "string") {
                    description = obj.description;
                  }
                }
              }
            }
            emitDiscovery(toolName, description, inputSchema);
          }

          return result;
        };
      }

      if (prop === "registerTool") {
        return (...args: unknown[]) => {
          // registerTool(name: string, config: object, cb: Function)
          // Callback is always the 3rd argument (index 2)
          const toolName = typeof args[0] === "string" ? args[0] : "unknown";
          if (args.length >= 3 && typeof args[2] === "function") {
            const originalCb = args[2] as (...cbArgs: unknown[]) => unknown;
            args[2] = wrapToolCallback(
              originalCb,
              toolName,
              resolveSession,
              server,
              config,
              transport,
              sdkVersion,
              tokenCache,
            );
          }

          const result = (originalRegisterTool as (...a: unknown[]) => unknown)(...args);

          // Emit tool_discovery event (once per tool name)
          if (!emittedToolDiscoveries.has(toolName)) {
            emittedToolDiscoveries.add(toolName);
            let description: string | undefined;
            let inputSchema: Record<string, unknown> | undefined;
            const configArg = args[1];
            if (configArg && typeof configArg === "object") {
              const obj = configArg as Record<string, unknown>;
              if (typeof obj.description === "string") {
                description = obj.description;
              }
              if (obj.inputSchema && typeof obj.inputSchema === "object") {
                inputSchema = obj.inputSchema as Record<string, unknown>;
              }
            }
            emitDiscovery(toolName, description, inputSchema);
          }

          return result;
        };
      }

      if (prop === "connect") {
        return async (mcpTransport: unknown) => {
          // Store transport reference for lazy sessionId lookup in getSession()
          currentMcpTransport = mcpTransport as Record<string, unknown>;
          const sessionIdFromTransport =
            typeof currentMcpTransport.sessionId === "string"
              ? currentMcpTransport.sessionId
              : undefined;

          session = {
            sessionId: sessionIdFromTransport
              ? deriveSessionId(sessionIdFromTransport)
              : generateSessionId(),
            userId: null,
            userTraits: {},
            platform: detectPlatform({
              clientName: undefined, // filled in after initialize
            }),
            stepSequence: 0,
          };
          tokenCache.current = null;

          const result = await originalConnect(
            mcpTransport as Parameters<typeof originalConnect>[0],
          );

          // Connection event is deferred to the first tool call (see wrapToolCallback)
          // so that OpenAI's per-tool-call reconnects don't produce duplicate events.

          return result;
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Extract parameter keys from a ZodRawShape (used in tool() overloads).
 * Returns a minimal JSON Schema-like representation with property names,
 * or undefined if the arg is not a ZodRawShape.
 */
function extractParamKeys(obj: unknown): Record<string, unknown> | undefined {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return undefined;
  // Heuristic: ZodRawShape values have a _def property (Zod internal marker)
  const isZodShape = keys.some(
    (k) => record[k] && typeof record[k] === "object" && "_def" in (record[k] as object),
  );
  if (!isZodShape) return undefined;
  const properties: Record<string, unknown> = {};
  for (const key of keys) {
    properties[key] = {};
  }
  return { type: "object", properties };
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

/**
 * Deep-clone tool arguments and merge serializable fields from RequestHandlerExtra.
 * Extra fields are prefixed with `_` to avoid collisions with tool arguments.
 */
function extractInputValues(args: unknown, extra: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  try {
    const clone = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
    if (extra && typeof extra === "object") {
      const ex = extra as Record<string, unknown>;
      // Serializable extra fields (skip signal, functions, taskStore)
      if (ex._meta != null) clone._meta = JSON.parse(JSON.stringify(ex._meta));
      if (typeof ex.sessionId === "string") clone._sessionId = ex.sessionId;
      if (ex.requestId != null) clone._requestId = ex.requestId;
      if (typeof ex.taskId === "string") clone._taskId = ex.taskId;
      if (ex.taskRequestedTtl !== undefined) clone._taskRequestedTtl = ex.taskRequestedTtl;
      if (ex.requestInfo != null) clone._requestInfo = JSON.parse(JSON.stringify(ex.requestInfo));
    }
    return clone;
  } catch {
    return undefined;
  }
}

/**
 * Replace binary data (base64 image, audio, resource blob) with size placeholders.
 */
function sanitizeContentItem(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  const entry = item as Record<string, unknown>;
  if ((entry.type === "image" || entry.type === "audio") && typeof entry.data === "string") {
    return {
      ...entry,
      data: `[binary:${String(entry.mimeType ?? "unknown")}:${(entry.data as string).length}]`,
    };
  }
  if (entry.type === "resource" && entry.resource && typeof entry.resource === "object") {
    const resource = entry.resource as Record<string, unknown>;
    if (typeof resource.blob === "string") {
      return {
        ...entry,
        resource: {
          ...resource,
          blob: `[binary:${String(resource.mimeType ?? "unknown")}:${(resource.blob as string).length}]`,
        },
      };
    }
  }
  return item;
}

/**
 * Extract the full MCP CallToolResult for output capture.
 * Includes content (with binary sanitization), structuredContent, isError, _meta.
 * Sizing is handled by ingest field limits.
 */
function extractOutputContent(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") return undefined;
  const res = result as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  if (Array.isArray(res.content)) {
    output.content = res.content.map(sanitizeContentItem);
  }

  if (res.structuredContent !== undefined) {
    output.structuredContent = JSON.parse(JSON.stringify(res.structuredContent));
  }

  if (res.isError !== undefined) {
    output.isError = res.isError;
  }

  // Captured BEFORE widget token injection (line ~175)
  if (res._meta && typeof res._meta === "object") {
    output._meta = JSON.parse(JSON.stringify(res._meta));
  }

  if (Object.keys(output).length === 0) return undefined;
  try {
    return JSON.parse(JSON.stringify(output)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
