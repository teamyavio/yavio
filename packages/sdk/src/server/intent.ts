import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IntentConfig } from "../core/types.js";

/**
 * User intent capture.
 *
 * When enabled, the SDK advertises an extra required string parameter named
 * `context` on every tool (via a wrapped tools/list handler) so the calling
 * model explains why it is invoking the tool. The value is read and removed
 * from the raw request in a wrapped tools/call handler BEFORE the MCP SDK
 * validates arguments — so strict schemas never reject it and the customer's
 * handler never sees it. Captured intents reach the tool_call event through
 * AsyncLocalStorage.
 *
 * Registered tool schemas are never modified: mixing our Zod instance into a
 * customer shape can throw ("Mixed Zod versions detected") and strict schemas
 * would reject the extra key. Everything happens at the protocol layer.
 */

/** Hard cap so the ingest field limit (2 KB) can never wipe the whole field. */
export const MAX_INTENT_LENGTH = 500;

export interface CapturedIntent {
  intent: string;
  source: "context_parameter" | "inferred";
}

interface IntentStore {
  captured: CapturedIntent | null;
}

const intentStore = new AsyncLocalStorage<IntentStore>();

/** Read the intent captured for the current tool call, if any. */
export function getCapturedIntent(): CapturedIntent | null {
  return intentStore.getStore()?.captured ?? null;
}

/** Trim, drop empty, clamp. Returns null for anything unusable. */
function normalizeIntent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_INTENT_LENGTH);
}

/**
 * Does a schema argument define its own `context` key? Handles ZodRawShape /
 * plain-object shorthand (keys directly), Zod object schemas (`.shape`), and
 * raw JSON Schema (`.properties`). Checked as an OR across all three shapes:
 * a false positive merely skips capture for one tool, while a false negative
 * would strip a genuine customer argument — so ambiguity resolves to true.
 */
function shapeHasContext(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const obj = schema as Record<string, unknown>;
  try {
    if ("context" in obj) return true;
    const shape = obj.shape;
    if (shape && typeof shape === "object" && "context" in (shape as object)) return true;
    const properties = obj.properties;
    if (properties && typeof properties === "object" && "context" in (properties as object)) {
      return true;
    }
    return false;
  } catch {
    return true; // treat unreadable schemas as owning `context` — never capture/strip
  }
}

/** Extract the literal `method` value from a Zod request schema (v3 or v4). */
function requestMethod(schema: unknown): string | undefined {
  try {
    const shape = (schema as { shape?: Record<string, unknown> } | undefined)?.shape;
    const field = shape?.method;
    if (!field || typeof field !== "object") return undefined;
    const direct = (field as { value?: unknown }).value;
    if (typeof direct === "string") return direct;
    const def = (field as { _def?: { value?: unknown; values?: unknown[] } })._def;
    if (typeof def?.value === "string") return def.value;
    if (Array.isArray(def?.values) && typeof def.values[0] === "string") return def.values[0];
    return undefined;
  } catch {
    return undefined;
  }
}

type RequestHandler = (request: unknown, extra: unknown) => Promise<unknown>;

interface RequestLike {
  params?: {
    name?: unknown;
    arguments?: Record<string, unknown>;
  };
}

interface LowLevelServerLike {
  setRequestHandler?: (schema: unknown, handler: RequestHandler) => unknown;
  _requestHandlers?: Map<string, RequestHandler>;
}

interface RegisteredToolsHost {
  _registeredTools?: Record<string, { inputSchema?: unknown } | undefined>;
}

export interface IntentController {
  /**
   * Record a tool registration seen by the proxy. `schemas` are the candidate
   * schema-shaped arguments; the tool is eligible for capture only when none
   * of them defines its own `context` key.
   */
  noteToolRegistration(toolName: string, schemas: unknown[]): void;
  /** Patch the underlying low-level server. Idempotent per server. */
  install(server: McpServer): void;
}

const installedServers = new WeakSet<object>();
const wrappedHandlers = new WeakSet<RequestHandler>();

export function createIntentController(config: IntentConfig): IntentController {
  // toolName -> tool defines its own `context` param. Absent = unknown, and
  // unknown tools are NOT captured/stripped: silently missing an intent is
  // harmless, deleting a genuine customer argument is not.
  const hasOwnContext = new Map<string, boolean>();

  // The McpServer this controller is installed on — used to consult the LIVE
  // registered schema at call time, so RegisteredTool.update() and tools
  // registered before withYavio() are classified correctly without waiting
  // for a tools/list on this instance.
  let toolsHost: RegisteredToolsHost | null = null;

  function liveOwnsContext(toolName: string): boolean | undefined {
    try {
      const tool = toolsHost?._registeredTools?.[toolName];
      if (!tool || typeof tool !== "object") return undefined;
      return shapeHasContext(tool.inputSchema);
    } catch {
      return undefined;
    }
  }

  const isEligible = (toolName: unknown): toolName is string => {
    if (typeof toolName !== "string") return false;
    // The live schema is authoritative; the registration/list-time map is the
    // fallback when the private registry is unreadable on this MCP SDK version.
    const live = liveOwnsContext(toolName);
    if (live !== undefined) return live === false;
    return hasOwnContext.get(toolName) === false;
  };

  function wrapCallHandler(handler: RequestHandler): RequestHandler {
    if (wrappedHandlers.has(handler)) return handler;
    const wrapped: RequestHandler = async (request, extra) => {
      let captured: CapturedIntent | null = null;
      let downstream = request;
      const req = request as RequestLike;
      const toolName = req?.params?.name;

      if (isEligible(toolName)) {
        const args = req.params?.arguments;
        if (args && typeof args === "object") {
          const intent = normalizeIntent(args.context);
          if (intent) captured = { intent, source: "context_parameter" };
          if ("context" in args) {
            const { context: _context, ...rest } = args;
            downstream = { ...req, params: { ...req.params, arguments: rest } };
          }
        }
        if (!captured && config.fallback) {
          try {
            const inferred = normalizeIntent(await config.fallback(toolName, args));
            if (inferred) captured = { intent: inferred, source: "inferred" };
          } catch {
            // A broken fallback must never break the tool call
          }
        }
      }

      return intentStore.run({ captured }, () => handler(downstream, extra));
    };
    wrappedHandlers.add(wrapped);
    return wrapped;
  }

  interface ToolEntry {
    name?: unknown;
    inputSchema?: Record<string, unknown>;
    [key: string]: unknown;
  }

  function injectIntoListedTool(tool: ToolEntry): ToolEntry {
    const name = typeof tool?.name === "string" ? tool.name : undefined;
    const schema = tool?.inputSchema;

    // The advertised JSON Schema is authoritative for classification: we never
    // touch registered schemas, so a `context` property here is the customer's.
    if (schema && typeof schema === "object") {
      if (schema.oneOf || schema.allOf || schema.anyOf) {
        if (name) hasOwnContext.set(name, true); // opt this tool out entirely
        return tool;
      }
      const properties = schema.properties;
      if (properties && typeof properties === "object" && "context" in (properties as object)) {
        if (name) hasOwnContext.set(name, true);
        return tool;
      }
    }
    if (name) hasOwnContext.set(name, false);

    const copy: Record<string, unknown> = schema
      ? (JSON.parse(JSON.stringify(schema)) as Record<string, unknown>)
      : { type: "object", properties: {} };
    if (copy.additionalProperties === false) {
      copy.additionalProperties = undefined;
    }
    const properties = (copy.properties ?? {}) as Record<string, unknown>;
    properties.context = { type: "string", description: config.description };
    copy.properties = properties;
    if (config.required) {
      const required = Array.isArray(copy.required) ? (copy.required as unknown[]) : [];
      if (!required.includes("context")) required.push("context");
      copy.required = required;
    }
    return { ...tool, inputSchema: copy };
  }

  function wrapListHandler(handler: RequestHandler): RequestHandler {
    if (wrappedHandlers.has(handler)) return handler;
    const wrapped: RequestHandler = async (request, extra) => {
      const result = (await handler(request, extra)) as { tools?: ToolEntry[] } | undefined;
      if (result && Array.isArray(result.tools)) {
        return { ...result, tools: result.tools.map(injectIntoListedTool) };
      }
      return result;
    };
    wrappedHandlers.add(wrapped);
    return wrapped;
  }

  return {
    noteToolRegistration(toolName, schemas) {
      // Only positive determination enables capture. Any schema-ish argument
      // carrying a `context` key (including annotations — false positives are
      // safe) marks the tool as owning the parameter.
      const owns = schemas.some((s) => shapeHasContext(s));
      hasOwnContext.set(toolName, owns);
    },

    install(server) {
      try {
        const low = (server as unknown as { server?: LowLevelServerLike }).server;
        if (!low || typeof low.setRequestHandler !== "function" || installedServers.has(low)) {
          return;
        }
        installedServers.add(low);
        toolsHost = server as unknown as RegisteredToolsHost;

        // Seed classification for tools registered before withYavio(), so a
        // fresh instance strips correctly even when tools/call arrives before
        // it ever served a tools/list (stateless per-request deployments).
        try {
          for (const [name, tool] of Object.entries(toolsHost._registeredTools ?? {})) {
            hasOwnContext.set(name, shapeHasContext(tool?.inputSchema));
          }
        } catch {
          // Registry unreadable — classification falls back to tools/list time
        }

        // McpServer registers its tools/list + tools/call handlers lazily on
        // the first tool registration — usually AFTER withYavio() runs, so the
        // patch below sees them. Handlers registered before us are wrapped
        // in place via the handler map.
        const originalSet = low.setRequestHandler.bind(low);
        low.setRequestHandler = (schema: unknown, handler: RequestHandler) => {
          const method = requestMethod(schema);
          if (method === "tools/call") return originalSet(schema, wrapCallHandler(handler));
          if (method === "tools/list") return originalSet(schema, wrapListHandler(handler));
          return originalSet(schema, handler);
        };

        const handlers = low._requestHandlers;
        if (handlers instanceof Map) {
          const existingCall = handlers.get("tools/call");
          if (existingCall) handlers.set("tools/call", wrapCallHandler(existingCall));
          const existingList = handlers.get("tools/list");
          if (existingList) handlers.set("tools/list", wrapListHandler(existingList));
        }
      } catch {
        // Private API drift on an unexpected MCP SDK version: intent capture
        // silently stays off rather than breaking the customer's server.
      }
    },
  };
}
