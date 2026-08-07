import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { stripPii } from "../core/pii.js";
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
 * Exception: on widget-invoked tools (`openai/widgetAccessible`, MCP Apps
 * `ui.visibility: ["app"]`) `context` is advertised as OPTIONAL — the widget
 * iframe calls those tools without it, and a required parameter would make
 * the host refuse every such call once it refreshes cached schemas. Capture
 * still applies when the value is present. See isWidgetInvoked.
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

/**
 * Bounds the regex work before redaction. The intent arrives from a model and
 * is otherwise unbounded, so redacting an arbitrarily long string first would
 * be an open-ended cost. Set far above MAX_INTENT_LENGTH so the cut is very
 * unlikely to land inside a real identifier — see normalizeIntent.
 */
const SAFETY_CEILING = MAX_INTENT_LENGTH * 8;

/**
 * Trim, drop empty, redact, clamp. Returns null for anything unusable.
 *
 * ORDER MATTERS, and it was wrong until 2026-08-07: this used to clamp to
 * MAX_INTENT_LENGTH and leave redaction to buildToolCallEvent, which produced
 * two distinct defects.
 *
 * 1. Clamping first cut PII in half at the boundary. An email truncated to
 *    "alice@corp." no longer matches the email pattern, so a partially
 *    redacted — still linkable — value shipped and looked scrubbed on
 *    inspection.
 * 2. Redaction tokens are LONGER than what they replace ("a@b.co" is 6 chars,
 *    "[EMAIL_REDACTED]" is 16), so redacting after the clamp pushed the stored
 *    value back over the 500 characters the docs promise.
 *
 * Redacting before the clamp fixes both: nothing is cut mid-identifier, and
 * the returned string is genuinely <= MAX_INTENT_LENGTH.
 */
function normalizeIntent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const redacted = stripPii(trimmed.slice(0, SAFETY_CEILING));
  return redacted.slice(0, MAX_INTENT_LENGTH) || null;
}

/**
 * Does a Zod object accept keys it does not declare? Such a schema hands
 * `context` to the customer's handler as a real argument even though it is
 * absent from `.shape`, so the tool must be left alone.
 */
function acceptsUnknownKeys(obj: Record<string, unknown>): boolean {
  // Zod 4 also exposes `_def`, so branch on the version marker first —
  // otherwise the v3 probes below misread a v4 schema's catchall.
  const v4Def = (obj._zod as { def?: { catchall?: unknown } } | undefined)?.def;
  if (v4Def) {
    const catchall = v4Def.catchall as { _zod?: { def?: { type?: string } } } | undefined;
    // strict()/strictObject() set a `never` catchall; loose/catchall set a real one.
    return catchall !== undefined && catchall._zod?.def?.type !== "never";
  }

  const v3 = obj._def as
    | { unknownKeys?: string; catchall?: { _def?: { typeName?: string } } }
    | undefined;
  if (v3?.unknownKeys === "passthrough") return true;
  if (v3?.catchall && v3.catchall._def?.typeName !== "ZodNever") return true;
  return false;
}

/**
 * Does a schema argument define (or accept) its own `context` key? Handles
 * ZodRawShape / plain-object shorthand (keys directly), Zod object schemas
 * (`.shape`, including the internal defs where it is lazy), and raw JSON
 * Schema (`.properties`).
 *
 * A false positive merely skips capture for one tool; a false negative would
 * delete a genuine customer argument and break their tool. So anything we
 * cannot read confidently — a wrapped schema (`.refine`, `.transform`, union,
 * lazy) whose keys are invisible, or one that accepts unknown keys — resolves
 * to true.
 */
function shapeHasContext(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const obj = schema as Record<string, unknown>;
  try {
    // Raw shape / plain-object shorthand: parameter names are the keys.
    if ("context" in obj) return true;

    // Raw JSON Schema.
    const properties = obj.properties;
    if (properties && typeof properties === "object" && "context" in (properties as object)) {
      return true;
    }

    const isZod = "_def" in obj || "_zod" in obj;
    if (!isZod) return false;

    const rawShape =
      obj.shape ??
      (obj._zod as { def?: { shape?: unknown } } | undefined)?.def?.shape ??
      (obj._def as { shape?: unknown } | undefined)?.shape;
    const shape = typeof rawShape === "function" ? (rawShape as () => unknown)() : rawShape;

    if (shape && typeof shape === "object") {
      if ("context" in (shape as object)) return true;
      return acceptsUnknownKeys(obj);
    }

    // A Zod schema whose keys we cannot see (ZodEffects from .refine/
    // .transform, ZodUnion, ZodOptional, ZodLazy…). It may well declare
    // `context`; never strip on a guess.
    return true;
  } catch {
    return true;
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
   * of them defines its own `context` key. `meta` is the registration
   * config's `_meta`, when the call form carries one — the only reliable
   * widget-invokability source on MCP SDKs older than 1.18.0, which drop
   * `_meta` before it reaches the registry or tools/list.
   */
  noteToolRegistration(toolName: string, schemas: unknown[], meta?: unknown): void;
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

  // toolName -> widget may invoke this tool. Fed from three places: the
  // registration-time config's `_meta` (via noteToolRegistration), the live
  // registry at install(), and listed entries at tools/list time. The
  // registration-time record matters most: MCP SDK versions before 1.18.0
  // accept `_meta` in registerTool but drop it — it never reaches the
  // registry or tools/list — so without this record the widget exemption
  // would be silently inert on every supported version below 1.18 while the
  // proxy's registerTool interceptor saw the truth all along.
  const widgetInvoked = new Map<string, boolean>();

  const isWidgetTool = (toolName: unknown): boolean =>
    typeof toolName === "string" && widgetInvoked.get(toolName) === true;

  // Once per tool: config demanded required context, the widget exemption
  // overrode it. Without this line the override is indistinguishable from a
  // client that stopped filling the parameter.
  const loggedWidgetOverride = new Set<string>();

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

  /**
   * Every signal can VETO capture; none can force it. A tool is stripped only
   * when it was positively classified as not owning `context` (at install,
   * registration or tools/list) AND its live schema still agrees. That keeps
   * opt-outs recorded at tools/list — advertised `context`, unreadable
   * schemas, oneOf/allOf/anyOf — from being overridden by the live check.
   */
  const isEligible = (toolName: unknown): toolName is string => {
    if (typeof toolName !== "string") return false;
    if (hasOwnContext.get(toolName) !== false) return false;
    return liveOwnsContext(toolName) !== true;
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
        // No fallback for context-less calls on widget-invoked tools: those
        // are presumptively the widget's own machine traffic (a 3s auto-
        // refresh, a filter-bar click), and inferring an intent for each would
        // record boilerplate "inferred" entries at machine frequency,
        // drowning the real intents the fallback exists to approximate.
        if (!captured && config.fallback && !isWidgetTool(toolName)) {
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
    _meta?: unknown;
    [key: string]: unknown;
  }

  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  /**
   * Does this `_meta` mark a tool the app's own widget (iframe) may invoke,
   * rather than only the model? Signals, in order of authority:
   *
   * 1. `openai/widgetAccessible: true` (OpenAI Apps SDK).
   * 2. An explicit MCP Apps visibility — nested `ui.visibility` wins over the
   *    flat `ui/visibility` key (both exist in the wild; the fallthrough must
   *    be `??`, not a ternary, or a nested `ui` object shadows the flat key).
   *    A bare string `"app"` is accepted alongside the spec's array form: the
   *    off-spec authoring slip is cheap to tolerate and misreading it would
   *    recreate exactly the failure this code exists to prevent.
   * 3. No visibility at all but a `resourceUri` (nested or flat): MCP Apps
   *    defaults omitted visibility to ["model", "app"], so a tool that
   *    participates in UI is app-callable unless it says otherwise. Skybridge
   *    emits precisely this shape for every view-owning tool. An app whose
   *    widget never calls its view tool can keep required `context` there by
   *    declaring `ui.visibility: ["model"]` explicitly.
   *
   * Why this matters: widget calls carry only the tool's real arguments — an
   * iframe cannot know to send `context` — so advertising `context` as
   * REQUIRED on such a tool makes the host refuse every widget call as
   * schema-invalid. The failure is delayed (hosts cache connector schemas
   * until a refresh) and invisible server-side (the calls never arrive).
   * Observed in production on 2026-08-07: a widget's 3s auto-refresh went
   * from 83 calls/day to zero the moment the connector re-fetched schemas.
   *
   * There is no valid use of a required `context` on a widget-invoked tool,
   * so this is enforced automatically rather than left to configuration.
   */
  function metaIndicatesWidget(meta: unknown): boolean {
    if (!isPlainObject(meta)) return false;
    if (meta["openai/widgetAccessible"] === true) return true;

    const ui = isPlainObject(meta.ui) ? meta.ui : undefined;
    const visibility = (ui ? ui.visibility : undefined) ?? meta["ui/visibility"];
    if (visibility !== undefined) {
      if (visibility === "app") return true;
      return Array.isArray(visibility) && visibility.includes("app");
    }

    if (ui && typeof ui.resourceUri === "string") return true;
    if (typeof meta["ui/resourceUri"] === "string") return true;
    return false;
  }

  function injectIntoListedTool(tool: ToolEntry): ToolEntry {
    const name = typeof tool?.name === "string" ? tool.name : undefined;
    const schema = tool?.inputSchema;

    /** Advertise nothing and never strip: the tool keeps its own `context`. */
    const optOut = (): ToolEntry => {
      if (name) hasOwnContext.set(name, true);
      return tool;
    };

    // Symmetry: only advertise `context` on tools we will strip it from again.
    // Advertising it on an opted-out tool would push the model into sending an
    // argument the customer's own schema then rejects.
    if (name && hasOwnContext.get(name) === true) return tool;

    if (schema !== undefined) {
      if (!isPlainObject(schema)) return optOut();
      if (schema.oneOf || schema.allOf || schema.anyOf) return optOut();
      if (schema.properties !== undefined && !isPlainObject(schema.properties)) return optOut();
      if (isPlainObject(schema.properties) && "context" in schema.properties) return optOut();
      // Declares no `context` but accepts unknown keys, so `context` may still
      // reach the handler as a real argument (passthrough / catchall).
      if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
        return optOut();
      }
    }
    if (name) hasOwnContext.set(name, false);

    const copy: Record<string, unknown> = schema
      ? (JSON.parse(JSON.stringify(schema)) as Record<string, unknown>)
      : { type: "object", properties: {} };
    if (copy.additionalProperties === false) {
      copy.additionalProperties = undefined;
    }
    const properties = isPlainObject(copy.properties) ? copy.properties : {};
    properties.context = { type: "string", description: config.description };
    copy.properties = properties;

    // Classify from the listed `_meta` when the MCP SDK forwarded one;
    // otherwise fall back to what the registration-time config declared
    // (pre-1.18 MCP SDKs drop `_meta` before it reaches tools/list).
    const widget =
      tool._meta !== undefined
        ? metaIndicatesWidget(tool._meta)
        : name !== undefined && widgetInvoked.get(name) === true;
    if (name) widgetInvoked.set(name, widget);

    // Widget-invoked tools get `context` as optional regardless of config:
    // capture still works when a model call fills it, while the widget's own
    // context-less calls stay schema-valid. See metaIndicatesWidget.
    if (config.required && !widget) {
      const required = Array.isArray(copy.required) ? (copy.required as unknown[]) : [];
      if (!required.includes("context")) required.push("context");
      copy.required = required;
    }
    if (widget) {
      // A customer schema may already name "context" in `required` without
      // declaring the property (legal JSON Schema, e.g. a stale leftover) —
      // that would silently defeat the exemption, so drop it here.
      if (Array.isArray(copy.required)) {
        copy.required = (copy.required as unknown[]).filter((k) => k !== "context");
      }
      if (config.required && name && !loggedWidgetOverride.has(name)) {
        loggedWidgetOverride.add(name);
        console.info(
          `[yavio] Intent context advertised as OPTIONAL on widget-invoked tool "${name}" (a required parameter would make the host refuse the widget's own calls). Model calls that fill it are still captured.`,
        );
      }
    }
    return { ...tool, inputSchema: copy };
  }

  function wrapListHandler(handler: RequestHandler): RequestHandler {
    if (wrappedHandlers.has(handler)) return handler;
    const wrapped: RequestHandler = async (request, extra) => {
      const result = (await handler(request, extra)) as { tools?: ToolEntry[] } | undefined;
      if (result && Array.isArray(result.tools)) {
        return {
          ...result,
          // One unexpected entry must never take down the whole tool list.
          tools: result.tools.map((tool) => {
            try {
              return injectIntoListedTool(tool);
            } catch {
              return tool;
            }
          }),
        };
      }
      return result;
    };
    wrappedHandlers.add(wrapped);
    return wrapped;
  }

  return {
    noteToolRegistration(toolName, schemas, meta) {
      // Only positive determination enables capture. Any schema-ish argument
      // carrying a `context` key (including annotations — false positives are
      // safe) marks the tool as owning the parameter.
      const owns = schemas.some((s) => shapeHasContext(s));
      hasOwnContext.set(toolName, owns);
      // Record widget-invokability from the registration config. Only when a
      // `_meta` was actually supplied: absence here must not erase a value a
      // more informed source recorded.
      if (meta !== undefined) widgetInvoked.set(toolName, metaIndicatesWidget(meta));
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
            // Same guard as noteToolRegistration: only a present `_meta` may
            // write — old MCP SDKs never store one, and undefined must not
            // erase a registration-time record.
            const meta = (tool as { _meta?: unknown } | undefined)?._meta;
            if (meta !== undefined) widgetInvoked.set(name, metaIndicatesWidget(meta));
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
