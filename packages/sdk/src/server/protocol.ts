import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCallEvent } from "@yavio/shared/events";
import type { SessionState } from "../core/types.js";

/**
 * The protocol layer: wrappers around the low-level server's `tools/call`
 * and `tools/list` request handlers.
 *
 * Two concerns live here — the intent controller (advertise/strip/capture
 * `context`) and status detection (count the calls McpServer fails BEFORE the
 * tool callback runs: unknown tool, disabled tool, argument validation). Both
 * wrap the same handler, so the composition order is fixed in one place:
 * wrappers are applied innermost first, `[status, intent]` yields
 * `intent(status(mcpHandler))`. Status must be the inner one — it then runs
 * inside the intent store (a pre-handler failure still carries its intent) and
 * sees arguments with `context` already removed.
 *
 * Everything in here touches private MCP SDK API (`server.server`,
 * `setRequestHandler` patching, `_requestHandlers`). When that API is missing
 * the install reports false and the SDK degrades to callback-only
 * instrumentation — today's behaviour, never worse.
 */

export type RequestHandler = (request: unknown, extra: unknown) => Promise<unknown>;
export type HandlerWrapper = (handler: RequestHandler) => RequestHandler;

/** Session and trace resolved once per tools/call, shared by both layers. */
export interface CallContext {
  traceId: string;
  session: SessionState;
}

/**
 * One tools/call request in flight. Opened by the status wrapper; the callback
 * wrapper, when it runs inside one, hands its finished event over instead of
 * sending it, and the status wrapper sends exactly one event per frame once
 * the downstream handler is done. That is what makes "two events for one
 * call" impossible and lets a post-handler failure (output validation) patch
 * the callback's event before it leaves.
 */
export interface CallFrame {
  toolName: string;
  context: CallContext;
  event: ToolCallEvent | null;
}

const callFrames = new AsyncLocalStorage<CallFrame>();

/** The frame of the tools/call currently being handled, if any. */
export function currentCallFrame(): CallFrame | undefined {
  return callFrames.getStore();
}

export function runInCallFrame<T>(frame: CallFrame, fn: () => T): T {
  return callFrames.run(frame, fn);
}

interface LowLevelServerLike {
  setRequestHandler?: (schema: unknown, handler: RequestHandler) => unknown;
  _requestHandlers?: Map<string, RequestHandler>;
}

/** Extract the literal `method` value from a Zod request schema (v3 or v4). */
export function requestMethod(schema: unknown): string | undefined {
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

const installedServers = new WeakSet<object>();

export interface ProtocolWrappers {
  /** Applied innermost first. */
  call: HandlerWrapper[];
  /** Applied innermost first. */
  list: HandlerWrapper[];
}

/**
 * Patch the low-level server so every tools/call and tools/list handler —
 * registered before or after this runs — goes through the given wrappers.
 * Idempotent per server. Returns false when the private API is not there,
 * in which case nothing was changed.
 *
 * McpServer registers its tool handlers lazily on the first tool
 * registration, usually AFTER withYavio() ran, so the patched
 * setRequestHandler sees them; handlers already present are wrapped in place
 * through the handler map.
 */
export function installProtocolWrappers(server: McpServer, wrappers: ProtocolWrappers): boolean {
  try {
    const low = (server as unknown as { server?: LowLevelServerLike }).server;
    if (!low || typeof low.setRequestHandler !== "function") return false;
    if (installedServers.has(low)) return true;
    installedServers.add(low);

    // A handler that was composed once must not be composed again when the
    // SDK re-sets it, and a composed handler must never be wrapped a second
    // time — either would run the wrappers twice per call.
    const composedFor = new WeakMap<RequestHandler, RequestHandler>();
    const composedOutputs = new WeakSet<RequestHandler>();
    const compose = (handler: RequestHandler, list: HandlerWrapper[]): RequestHandler => {
      if (list.length === 0 || composedOutputs.has(handler)) return handler;
      const cached = composedFor.get(handler);
      if (cached) return cached;
      const out = list.reduce((inner, wrap) => wrap(inner), handler);
      composedFor.set(handler, out);
      composedOutputs.add(out);
      return out;
    };

    const originalSet = low.setRequestHandler.bind(low);
    low.setRequestHandler = (schema: unknown, handler: RequestHandler) => {
      const method = requestMethod(schema);
      if (method === "tools/call") return originalSet(schema, compose(handler, wrappers.call));
      if (method === "tools/list") return originalSet(schema, compose(handler, wrappers.list));
      return originalSet(schema, handler);
    };

    const handlers = low._requestHandlers;
    if (handlers instanceof Map) {
      const existingCall = handlers.get("tools/call");
      if (existingCall) handlers.set("tools/call", compose(existingCall, wrappers.call));
      const existingList = handlers.get("tools/list");
      if (existingList) handlers.set("tools/list", compose(existingList, wrappers.list));
    }
    return true;
  } catch {
    // Private API drift on an unexpected MCP SDK version: the protocol layer
    // silently stays off rather than breaking the customer's server.
    return false;
  }
}
