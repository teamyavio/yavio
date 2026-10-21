import { ErrorCode } from "@yavio/shared/error-codes";
import type { ToolCallEvent, ToolDiscoveryEvent } from "@yavio/shared/events";
import { normalizeRegionName } from "@yavio/shared/geo";
import {
  type ClientInfoSource,
  buildConnectionEvent,
  buildToolCallEvent,
  buildToolDiscoveryEvent,
  normalizeErrorMessage,
} from "../core/events.js";
import { deriveSessionId, generateSessionId, generateTraceId } from "../core/ids.js";
import { LruMap } from "../core/lru.js";
import { detectPlatform } from "../core/platform.js";
import type { CaptureConfig, McpServerLike, SessionState, YavioConfig } from "../core/types.js";
import type { Transport } from "../transport/types.js";
import { type RequestStore, runInContext } from "./context.js";
import { clientFromUserAgent, headerValue, readCallExtra } from "./extra.js";
import {
  type IntentContext,
  type IntentController,
  createIntentController,
  getCapturedIntent,
  getIntentContext,
} from "./intent.js";
import {
  type CallContext,
  type CallFrame,
  type HandlerWrapper,
  currentCallFrame,
  installProtocolWrappers,
  runInCallFrame,
} from "./protocol.js";
import { type SharedSessions, _resetSharedState, createSharedSessions, logOnce } from "./shared.js";
import { type MintResult, mintWidgetToken } from "./token.js";

function isMintResult(result: unknown): result is MintResult {
  return result !== null && typeof result === "object" && "token" in result;
}

/**
 * Mint the widget token for one tool call. Ingest binds the JWT's `tid` to
 * this trace id and rejects a widget batch under any other trace
 * (`WIDGET_TRACE_ID_MISMATCH`), and every call has its own trace id — so
 * there is nothing to cache, across calls or across instances (#133 review).
 * Runs on every call of a non-serverOnly server, bounded by the mint's own
 * timeout (token.ts): a slow ingest costs the call at most that. Returns
 * null when minting fails or times out — the caller skips the injection,
 * the result is returned untouched, and the failure is logged once per
 * process (`YAVIO-1103`). Resolves with null on every failure, its own
 * included: it is started before the handler and may go unawaited (handler
 * threw, non-object result), and an unawaited rejection would take the
 * process down.
 */
async function mintCallToken(
  config: YavioConfig,
  traceId: string,
  sessionId: string,
): Promise<string | null> {
  try {
    const result = await mintWidgetToken(config.endpoint, config.apiKey, traceId, sessionId);
    if (isMintResult(result)) return result.token;
    logOnce(ErrorCode.SDK.WIDGET_TOKEN_MINTING_FAILED, () =>
      console.warn(
        `[${ErrorCode.SDK.WIDGET_TOKEN_MINTING_FAILED}] Widget token minting ${result && "status" in result ? `returned HTTP ${result.status}` : "failed or timed out"} — tool results are returned without _meta.yavio until it succeeds. Shown once per process.`,
      ),
    );
  } catch {
    // Not reachable by design (mintWidgetToken catches); belt and braces.
  }
  return null;
}

/**
 * JSON-RPC code of McpError UrlElicitationRequired. By number: the MCP SDK
 * floor this package supports predates the enum member.
 */
const URL_ELICITATION_REQUIRED = -32042;

/** JSON-RPC InvalidParams. */
const INVALID_PARAMS = -32602;

/**
 * MCP SDK v2's refusal of a call to an unknown or disabled tool: a thrown
 * InvalidParams error whose text names only the tool (`Tool X not found`,
 * `Tool X disabled`) — the same wording v1 puts into an isError result.
 */
function isToolNotFoundError(error: unknown, toolName: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code !== INVALID_PARAMS || typeof message !== "string") return false;
  const text = message.replace(/^MCP error -?\d+: /, "");
  return text === `Tool ${toolName} not found` || text === `Tool ${toolName} disabled`;
}

/** A URL elicitation is a protocol flow McpServer passes to the client unwrapped, not a failure. */
function isUrlElicitationRequired(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === URL_ELICITATION_REQUIRED
  );
}

/**
 * The capture flags in force for one tool: the global `capture` config with
 * the tool's own `tools` override on top. `intent` is not part of it — the
 * intent controller resolves that flag itself.
 */
function resolveToolCapture(config: YavioConfig, toolName: string): CaptureConfig {
  // Own entries only: a tool named `constructor` has no override just because
  // Object has one.
  const override = Object.hasOwn(config.tools, toolName) ? config.tools[toolName] : undefined;
  if (!override) return config.capture;
  return {
    ...config.capture,
    ...(override.inputValues !== undefined ? { inputValues: override.inputValues } : {}),
    ...(override.outputValues !== undefined ? { outputValues: override.outputValues } : {}),
    ...(override.rejectedInputValues !== undefined
      ? { rejectedInputValues: override.rejectedInputValues }
      : {}),
  };
}

/**
 * Resolve everything a tool_call needs to know about its request before the
 * handler runs: the session (from the MCP session id, OpenAI's conversation
 * session, or the transport), lazy platform detection, the once-per-session
 * connection event, and a fresh trace id. Called once per tools/call by the
 * status wrapper, or by the callback wrapper when no frame is open.
 */
function openCallContext(
  extra: unknown,
  resolveSession: (sessionKey?: string) => SessionState,
  server: McpServerLike,
  config: YavioConfig,
  transport: Transport,
  sdkVersion: string,
): CallContext {
  // Read once, by shape (v1 RequestHandlerExtra or v2 ctx — see extra.ts).
  const ex = readCallExtra(extra);

  // The MCP session id (Mcp-Session-Id) is the most reliable correlation
  // signal. Fall back to OpenAI's conversation-scoped session from _meta:
  // OpenAI re-initializes MCP per tool call but sends a stable "openai/session".
  const openaiSessionId = ex.meta?.["openai/session"];
  const sessionKey =
    ex.sessionId ?? (typeof openaiSessionId === "string" ? openaiSessionId : undefined);
  const session = resolveSession(sessionKey);

  // Client identity: on the 2026-07-28 protocol era every request carries it
  // (v2 envelope); otherwise from the MCP initialize handshake, available by
  // the time the first tool call arrives on a long-lived server; otherwise —
  // a stateless host, whose instance serving tools/call never saw initialize
  // — the first product token of the request's User-Agent (#142). Only
  // fetched while still needed: for the once-per-session connection event
  // and unresolved platforms. `get`, not `has`: a hit refreshes the mark's
  // recency, so an active conversation is never aged out of the dedup by
  // newer ones.
  const connectionKey = dedupKey(config.apiKey, session.sessionId);
  const connectionEmitted = emittedConnections.get(connectionKey) === true;
  let clientInfo: { name?: string; version?: string } | undefined;
  let clientInfoSource: ClientInfoSource | undefined;
  if (session.platform === "unknown" || !connectionEmitted) {
    clientInfo = ex.client;
    if (clientInfo?.name) clientInfoSource = "envelope";
    if (!clientInfo?.name) {
      try {
        const fromInitialize = (
          server.server as {
            getClientVersion?: () => { name?: string; version?: string } | undefined;
          }
        )?.getClientVersion?.();
        if (fromInitialize?.name) {
          clientInfo = fromInitialize;
          clientInfoSource = "initialize";
        }
      } catch {
        // Keep whatever the envelope said.
      }
    }
    if (!clientInfo?.name) {
      const fromUserAgent = clientFromUserAgent(headerValue(ex.requestHeaders, "user-agent"));
      if (fromUserAgent) {
        clientInfo = fromUserAgent;
        clientInfoSource = "user_agent";
      }
    }
  }

  // Lazy platform detection — must run before the connection event is
  // built so the event carries the resolved platform, not "unknown".
  // HTTP transports also expose request headers (v1 extra.requestInfo, v2
  // extra.http.req), which cover clients whose handshake identity is
  // unrecognised.
  if (session.platform === "unknown") {
    const httpHeaders = ex.requestHeaders;
    const userAgent = headerValue(httpHeaders, "user-agent");
    const origin = headerValue(httpHeaders, "origin");
    if (clientInfo?.name || userAgent || origin) {
      session.platform = detectPlatform({ clientName: clientInfo?.name, userAgent, origin });
    }
  }

  // Emit deferred connection event on the first tool call for this session.
  // Deferred from connect() so that OpenAI's per-tool-call reconnects don't
  // spam a connection event for every tool call in the same conversation.
  if (!connectionEmitted) {
    emittedConnections.set(connectionKey, true);
    const connectionEvent = buildConnectionEvent(
      {
        traceId: generateTraceId(),
        sessionId: session.sessionId,
        platform: session.platform,
        sdkVersion,
      },
      {
        // The wire protocol version the client sends on every Streamable HTTP
        // request (allowlisted in `_requestInfo` as well).
        protocolVersion: headerValue(ex.requestHeaders, "mcp-protocol-version"),
        clientName: clientInfo?.name,
        clientVersion: clientInfo?.version,
        clientInfoSource: clientInfo?.name ? clientInfoSource : undefined,
        intentEnabled: config.intent.enabled,
      },
    );
    transport.send([connectionEvent]);
  }

  return { traceId: generateTraceId(), session };
}

/**
 * Wrap a tool callback with Yavio instrumentation.
 *
 * Handles lazy platform detection, trace/session context,
 * latency measurement, and tool_call event emission.
 *
 * `capture` is the tool's resolved capture config (see resolveToolCapture);
 * nothing in here reads `config.capture` directly, so a per-tool override is
 * honoured on every path.
 */
function wrapToolCallback(
  originalCb: (...cbArgs: unknown[]) => unknown,
  toolName: string,
  resolveSession: (sessionKey?: string) => SessionState,
  server: McpServerLike,
  config: YavioConfig,
  capture: CaptureConfig,
  transport: Transport,
  sdkVersion: string,
): (...cbArgs: unknown[]) => Promise<unknown> {
  return async (...cbArgs: unknown[]) => {
    const extra = cbArgs[cbArgs.length - 1];

    // Inside a tools/call frame the status wrapper (protocol.ts) already
    // resolved the session and trace for this request — reuse them so both
    // layers agree, and hand the finished event to the frame instead of
    // sending it: the frame owner sends exactly one event per call once the
    // downstream handler is done. Without a frame (the handler invoked
    // directly, private API unavailable) behave as before: resolve here,
    // send here.
    const activeFrame = currentCallFrame();
    const frame = activeFrame && activeFrame.toolName === toolName ? activeFrame : undefined;
    let context: CallContext;
    try {
      context =
        frame?.context ??
        openCallContext(extra, resolveSession, server, config, transport, sdkVersion);
    } catch {
      // YAVIO-1100: instrumentation failed, the original call still runs.
      return originalCb(...cbArgs);
    }
    const { traceId, session } = context;
    const emit = (event: ToolCallEvent): void => {
      if (frame && frame.event === null) frame.event = event;
      else transport.send([event]);
    };
    const store: RequestStore = {
      traceId,
      session,
      transport,
      sdkVersion,
    };

    // The widget token's round trip hides behind the handler: started now
    // (trace and session are known), awaited once the result is in hand. A
    // mint whose result goes unused (non-object result, handler threw) is
    // dropped, so it must never reject: mintCallToken resolves null on every
    // failure, and the catch here guards the promise itself — an unhandled
    // rejection would exit the process. Server-only mode mints nothing so
    // the tool result is forwarded to the MCP client byte-for-byte.
    const mint = config.serverOnly
      ? null
      : mintCallToken(config, store.traceId, store.session.sessionId).catch(() => null);

    const startTime = performance.now();
    try {
      const result = await runInContext(store, () => originalCb(...cbArgs));
      const latencyMs = Math.round(performance.now() - startTime);

      // A result with `isError: true` is an error — that flag is how MCP
      // reports tool failures in-band (the model sees them; a throw would
      // reach it in the same shape). Derived from the result regardless of
      // output capture, so integrators with outputValues off still get a
      // correct error rate.
      const resultError = toolResultError(result);

      // The inputs need arguments to exist (a schema-less tool's callback gets
      // only `extra`); the client metadata — locale, country, subject — comes
      // from `extra` and is captured under the same flag whether or not the
      // tool takes arguments.
      const captureInput = capture.inputValues && cbArgs[0] !== extra;
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
          status: resultError ? "error" : "success",
          errorCategory: resultError ? "tool_error" : undefined,
          // The message is the result's own text — output. With output capture
          // off it stays out too: a handler echoing "no tariff for customer
          // number …" would otherwise leak the very input the flag hides.
          errorMessage: resultError && capture.outputValues ? resultError.message : undefined,
          inputKeys: captureInput ? extractInputKeys(cbArgs[0]) : undefined,
          inputTypes: captureInput ? extractInputTypes(cbArgs[0]) : undefined,
          inputValues: captureInput ? extractInputValues(cbArgs[0], extra, capture.geo) : undefined,
          outputContent: capture.outputValues ? extractOutputContent(result) : undefined,
          intentSignals: getCapturedIntent() ?? undefined,
          intentContext: intentContextFor(config),
          clientMeta: capture.inputValues ? extractClientMeta(extra, capture.geo) : undefined,
        },
      );
      emit(toolCallEvent);

      if (mint && result && typeof result === "object") {
        try {
          const token = await mint;
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
      // Nothing to record: the elicitation reaches the client as the
      // protocol intends, and the status wrapper has no business classifying
      // it either.
      if (isUrlElicitationRequired(error)) throw error;

      const latencyMs = Math.round(performance.now() - startTime);

      const captureInputOnError = capture.inputValues && cbArgs[0] !== extra;
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
          // Developer-written, so output capture does not gate it (unlike the
          // text of an isError result, see the success path). Input capture
          // does: messages routinely interpolate the arguments
          // (`IBAN ${iban} rejected`, a ZodError echoing received values),
          // and stripPii does not catch IBANs or customer numbers.
          errorMessage: capture.inputValues
            ? error instanceof Error
              ? error.message
              : String(error)
            : undefined,
          inputValues: captureInputOnError
            ? extractInputValues(cbArgs[0], extra, capture.geo)
            : undefined,
          intentSignals: getCapturedIntent() ?? undefined,
          intentContext: intentContextFor(config),
          clientMeta: capture.inputValues ? extractClientMeta(extra, capture.geo) : undefined,
        },
      );
      emit(toolCallEvent);

      throw error;
    }
  };
}

/**
 * intent_context for the current tool call (#73): what the intent layer
 * recorded, or `none` while intent capture is off — nothing is advertised
 * then, and NULL is left to mean "an SDK before 0.4.0". Unset only when
 * capture is on but the call never passed the intent wrapper (the protocol
 * layer could not be wrapped), where the advertisement is not known.
 */
function intentContextFor(config: YavioConfig): IntentContext | undefined {
  if (!config.intent.enabled) return "none";
  return getIntentContext() ?? undefined;
}

/**
 * Session ids that have already emitted a `connection` event. Module-level,
 * because a server that builds a new McpServer and proxy per request still
 * serves one ChatGPT conversation across many requests and must not emit a
 * connection event per tool call. Bounded: it used to be a plain Set that
 * kept one id per conversation for the life of the process (#120). A
 * conversation that falls out — evicted here, or evicted from its proxy's
 * session map — emits a fresh connection event on its next call, which also
 * marks that its state (user, step sequence) started over.
 *
 * Shared by every proxy in the process, keyed by `(apiKey, sessionId)`: two
 * instrumented servers reporting to the same project that see the same
 * conversation emit one connection event between them, while two projects
 * (two API keys) in one process each get their own.
 */
const MAX_EMITTED_CONNECTIONS = 10_000;
const emittedConnections = new LruMap<string, true>(MAX_EMITTED_CONNECTIONS);

/**
 * `(apiKey, toolName)` pairs that have emitted a tool_discovery event: once
 * per tool per project per process, however many instances register it.
 */
const emittedToolDiscoveries = new Set<string>();

/** A proxy createProxy built, with the options that a later wrap of the same server would compete with. */
export interface ExistingProxy<T = object> {
  proxy: T;
  endpoint: string;
  apiKey: string;
  instrumentExisting: boolean;
  /** `configFingerprint()` of the config the proxy was built with. */
  fingerprint: string;
}

/**
 * The resolved options that shape what a proxy captures — everything but the
 * endpoint and key, which are compared on their own — as stable JSON (keys
 * sorted at every level), so two wraps with the same options agree whatever
 * the order they were written in. A function option (`intent.fallback`) is
 * reduced to its presence. `shutdownTimeoutMs` is not part of it: it shapes
 * the process-level drain, not what a proxy captures.
 */
const fingerprints = new WeakMap<YavioConfig, string>();

export function configFingerprint(config: YavioConfig): string {
  // Once per resolved config object: createYavio() resolves once per client
  // and every wrap() compares and records the same string.
  const known = fingerprints.get(config);
  if (known !== undefined) return known;
  const stable = (value: unknown): unknown => {
    if (typeof value === "function") return "[function]";
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
      );
    }
    return value;
  };
  const fingerprint = JSON.stringify(
    stable({
      capture: config.capture,
      tools: config.tools,
      serverOnly: config.serverOnly,
      intent: config.intent,
    }),
  );
  fingerprints.set(config, fingerprint);
  return fingerprint;
}

/** Every proxy createProxy built, by the server it wraps, and by the proxy itself. */
const proxiesByServer = new WeakMap<object, ExistingProxy>();

/** A NUL cannot occur in an API key, so the pair cannot collide with another. */
const dedupKey = (apiKey: string, name: string): string => `${apiKey}\u0000${name}`;

/** Drop a session's connection-event mark (the shared session map's eviction hook). */
export function releaseConnectionMark(apiKey: string, sessionId: string): void {
  emittedConnections.delete(dedupKey(apiKey, sessionId));
}

/**
 * The proxy already wrapping this server (or the value itself when it is a
 * proxy), so wrapping twice never instruments twice.
 */
export function existingProxy<T extends object>(server: T): ExistingProxy<T> | undefined {
  return proxiesByServer.get(server) as ExistingProxy<T> | undefined;
}

/** @internal Reset global dedup state and the shared registry — exposed for testing only. */
export function _resetGlobalState(): void {
  emittedConnections.clear();
  emittedToolDiscoveries.clear();
  _resetSharedState();
}

export interface CreateProxyOptions {
  /**
   * Instrument the tools already registered on the server at wrap time
   * (`createYavio().wrap()`). Off by default: `withYavio()` tracks only the
   * tools registered through the proxy, as it always has, so a tool kept on
   * the raw server on purpose stays untracked.
   */
  instrumentExisting?: boolean;
}

/**
 * Create a Proxy around McpServer that intercepts tool()/registerTool() and connect()
 * to inject Yavio instrumentation transparently.
 *
 * `shared` is the session state that outlives this instance (#133): the
 * sessions map, owned by the process-level client so a per-request server
 * instance finds the conversation state its predecessors built. Without it
 * (tests building a proxy directly) the proxy gets a private one.
 */
export function createProxy<T extends McpServerLike>(
  server: T,
  config: YavioConfig,
  transport: Transport,
  sdkVersion: string,
  shared: SharedSessions = createSharedSessions((sessionId) =>
    releaseConnectionMark(config.apiKey, sessionId),
  ),
  options: CreateProxyOptions = {},
): T {
  // Session state of the connection itself: set on connect, used for calls
  // that carry no session key and for discovery events.
  let session: SessionState = {
    sessionId: generateSessionId(),
    userId: null,
    userTraits: {},
    platform: "unknown",
    stepSequence: 0,
  };

  // Discovery dedup, once per tool per project per process.
  const discoveryEmitted = (toolName: string): boolean =>
    emittedToolDiscoveries.has(dedupKey(config.apiKey, toolName));
  const markDiscovery = (toolName: string): void => {
    emittedToolDiscoveries.add(dedupKey(config.apiKey, toolName));
  };

  // Intent capture operates at the protocol layer (wrapped tools/list and
  // tools/call handlers on the low-level server) — registered tool schemas
  // are never modified. Tools with a per-tool `intent: false` override are
  // never advertised or captured (still stripped, see intent.ts).
  const intentDisabledTools = new Set(
    Object.entries(config.tools)
      .filter(([, override]) => override.intent === false)
      .map(([name]) => name),
  );
  const intent: IntentController | null = config.intent.enabled
    ? createIntentController(config.intent, intentDisabledTools)
    : null;
  intent?.attach(server);

  // Tools whose callback the proxy wrapped. A pre-handler failure is counted
  // only for these (or for a name that is not registered at all): a tool
  // deliberately registered on the unwrapped server must stay untracked.
  const instrumentedTools = new Set<string>();
  const isRegistered = (toolName: string): boolean => {
    try {
      const tools = (server as unknown as { _registeredTools?: Record<string, unknown> })
        ._registeredTools;
      // Registry unreadable: assume registered, i.e. never invent an event.
      // Own entries only: `constructor` or `__proto__` is not a registered
      // tool just because Object has it.
      return !tools || typeof tools !== "object" || Object.hasOwn(tools, toolName);
    } catch {
      return true;
    }
  };

  /**
   * Decide what the frame sends once McpServer's tools/call handler is done.
   * See protocol-layer-status.md for the table this implements.
   */
  /**
   * The callback's event, corrected for a failure that happened after the
   * handler returned a good-looking result: McpServer's output validation
   * (v1 and v2, surfaced as an isError result) or v2's wire validation of
   * the result (a thrown ProtocolError). A server bug the model saw as an
   * error. Keeps the handler's latency and captured output; corrects the
   * verdict. An event that already says error is left alone.
   */
  const postHandlerFailure = (
    event: ToolCallEvent,
    toolName: string,
    message: string | undefined,
  ): ToolCallEvent => {
    if (event.status !== "success") return event;
    const capture = resolveToolCapture(config, toolName);
    return {
      ...event,
      status: "error",
      error_category: "server",
      error_message:
        capture.outputValues && message !== undefined ? normalizeErrorMessage(message) : undefined,
    };
  };

  const finalizeCallEvent = (
    frame: CallFrame,
    args: unknown,
    extra: unknown,
    result: unknown,
  ): ToolCallEvent | null => {
    const { toolName, context } = frame;
    const resultError = toolResultError(result);

    if (frame.event) {
      return resultError
        ? postHandlerFailure(frame.event, toolName, resultError.message)
        : frame.event;
    }

    // The callback never ran. Only a failure is worth an event. (Registered
    // but uninstrumented tools never get here, see statusWrapper.)
    if (!resultError) return null;

    // Unknown tool, disabled tool, argument validation, task misconfiguration:
    // all InvalidParams-class failures of the request itself, handed over by
    // McpServer as one isError text. `validation` for all four. No latency —
    // the handler never ran. Inputs come from the RAW arguments, under the
    // tool's capture flags — resolved by name even when the tool is not (or
    // no longer) registered, so an override still holds for a removed tool a
    // client calls from a cached schema.
    const capture = resolveToolCapture(config, toolName);
    // The VALUES of a rejected call are exactly what the schema refused:
    // whatever the model put into an enum field, free text from the
    // conversation included, while a successful call only ever stores what
    // the schema accepted. Kept only with rejectedInputValues (#123). Without
    // it: the names and types of the parameters the tool's schema declares (a
    // key the model invented can carry free text as well as a value can), the
    // `_`-prefixed request context and the client metadata, and a value-free
    // reason instead of McpServer's text. `arguments` is optional in MCP, so
    // none of this depends on it having been sent.
    const keepValues = capture.inputValues && capture.rejectedInputValues;
    const declared = keepValues ? undefined : declaredParamNames(server, toolName);
    const shownArgs = keepValues ? args : pickDeclared(args, declared);
    return buildToolCallEvent(
      {
        traceId: context.traceId,
        sessionId: context.session.sessionId,
        userId: context.session.userId ?? undefined,
        platform: context.session.platform,
        sdkVersion,
      },
      {
        toolName,
        status: "error",
        errorCategory: "validation",
        // Result-derived text, so under outputValues; McpServer's text can
        // echo the rejected value (Zod 3), so as-is only with the values.
        errorMessage: !capture.outputValues
          ? undefined
          : keepValues
            ? resultError.message
            : valueFreeRejection(resultError.message, toolName),
        inputKeys: capture.inputValues ? nonEmpty(extractInputKeys(shownArgs)) : undefined,
        inputTypes: capture.inputValues ? nonEmpty(extractInputTypes(shownArgs)) : undefined,
        inputValues: capture.inputValues
          ? nonEmpty(extractInputValues(keepValues ? (args ?? {}) : {}, extra, capture.geo))
          : undefined,
        outputContent:
          capture.outputValues && keepValues ? extractOutputContent(result) : undefined,
        intentSignals: getCapturedIntent() ?? undefined,
        intentContext: intentContextFor(config),
        clientMeta: capture.inputValues ? extractClientMeta(extra, capture.geo) : undefined,
      },
    );
  };

  /**
   * Status detection at the protocol layer: one frame per tools/call, one
   * event per frame. Inner to the intent wrapper, so it runs inside the
   * intent store and sees arguments with `context` already removed.
   */
  const statusWrapper: HandlerWrapper = (handler) => async (request, extra) => {
    const params = (request as { params?: { name?: unknown; arguments?: unknown } } | undefined)
      ?.params;
    // No usable name: McpServer answers "not found" itself, and there is no
    // tool to attribute the call to (an empty name would be rejected by
    // ingest, "unknown" would collide with a tool of that name).
    if (typeof params?.name !== "string" || params.name === "") return handler(request, extra);
    const toolName = params.name;

    // A registered tool the proxy did not wrap (unwrapped server, task tool)
    // stays untracked: no frame, no session work, no connection event.
    if (!instrumentedTools.has(toolName) && isRegistered(toolName)) {
      return handler(request, extra);
    }

    // This runs outside McpServer's own try/catch: a failure here must never
    // fail the customer's call. Without a frame the callback wrapper falls
    // back to resolving and sending on its own.
    let frame: CallFrame;
    try {
      frame = {
        toolName,
        context: openCallContext(extra, resolveSession, server, config, transport, sdkVersion),
        event: null,
      };
    } catch {
      return handler(request, extra);
    }

    let result: unknown;
    try {
      result = await runInCallFrame(frame, () => handler(request, extra));
    } catch (error) {
      // A JSON-RPC error the proxy has no business classifying (today only
      // UrlElicitationRequired escapes McpServer's catch). The callback's own
      // event, if it produced one, still goes out.
      //
      // One exception: MCP SDK v2 throws InvalidParams for an unknown or
      // disabled tool where v1 returns an isError result, and the model sees
      // the same refusal either way. Counted as the validation failure it is
      // (same table as protocol-layer-status.md), then re-thrown unchanged.
      //
      // And one more: a throw AFTER the callback ran. McpServer converts a
      // handler's own throw into an isError result, so a throw that reaches
      // here with the callback's event in hand came from the layer above the
      // handler — v2's wire validation of the result (`Invalid tools/call
      // result: …`), which the client sees as a JSON-RPC error. The same
      // verdict as v1's output-schema failure: status error, category server.
      try {
        if (frame.event) {
          transport.send([
            isUrlElicitationRequired(error)
              ? frame.event
              : postHandlerFailure(frame.event, toolName, (error as Error)?.message),
          ]);
        } else if (isToolNotFoundError(error, toolName)) {
          const rejection = {
            isError: true,
            content: [{ type: "text", text: (error as Error).message }],
          };
          const event = finalizeCallEvent(frame, params?.arguments, extra, rejection);
          if (event) transport.send([event]);
        }
      } catch {
        // Analytics never changes what the client gets.
      }
      throw error;
    }
    try {
      const event = finalizeCallEvent(frame, params?.arguments, extra, result);
      if (event) transport.send([event]);
    } catch {
      // Analytics never changes what the client gets.
    }
    return result;
  };

  /**
   * tool_discovery from the tools/list result: the JSON Schema clients see,
   * converted by the MCP SDK itself (Zod 3 or 4, raw shape or object). The
   * schema handed to registerTool() is a Zod object whose serialisation is
   * Zod's internal state (#83). Inner to the intent wrapper, so the injected
   * `context` parameter is not part of the tool's registered schema. Only
   * tools the proxy wrapped, once per tool name per process, as before.
   */
  const discoveryWrapper: HandlerWrapper = (handler) => async (request, extra) => {
    const result = await handler(request, extra);
    try {
      const tools = (result as { tools?: unknown } | undefined)?.tools;
      if (Array.isArray(tools)) {
        // One batch for the listing, not one send per tool.
        const events: ToolDiscoveryEvent[] = [];
        for (const tool of tools as Array<Record<string, unknown> | null>) {
          const name = tool?.name;
          if (typeof name !== "string" || !instrumentedTools.has(name)) continue;
          if (discoveryEmitted(name)) continue;
          markDiscovery(name);
          events.push(
            discoveryEvent(
              name,
              typeof tool?.description === "string" ? tool.description : undefined,
              listedInputSchema(tool?.inputSchema),
            ),
          );
        }
        if (events.length > 0) transport.send(events);
      }
    } catch {
      // Discovery is best effort; the listing itself must never fail on it.
    }
    return result;
  };

  // Innermost first: intent(status(mcpHandler)). Returns false when the
  // private API is missing — then no frame is ever opened and the callback
  // wrapper keeps sending on its own, and discovery falls back to
  // registration time (keys only, see the interceptors below).
  const protocolInstalled = installProtocolWrappers(server, {
    call: intent ? [statusWrapper, intent.wrapCall] : [statusWrapper],
    list: intent ? [discoveryWrapper, intent.wrapList] : [discoveryWrapper],
  });

  // Reference to the current MCP transport for lazy sessionId lookup
  let currentMcpTransport: Record<string, unknown> | null = null;

  /**
   * Sessions by their derived id, for a server that serves many conversations
   * (stateless transports, OpenAI's per-call reconnects): identify(), the
   * traits and the step sequence belong to one conversation. One shared,
   * mutated session object used to carry a user identified in conversation A
   * onto conversation B's events, and two overlapping calls could swap session
   * ids. Shared across server instances through `shared` (#133); bounded,
   * see shared.ts.
   */
  const sessions = shared.sessions;
  /**
   * The session of the most recent tool call — what tool_discovery events
   * stamp, so a discovery emitted after a call carries that call's detected
   * platform and session id, as it did when one session object served all
   * calls. Reset on connect, like the connection session.
   */
  let activeSession: SessionState | null = null;

  /**
   * Resolve the session for the current tool call.
   *
   * If a session key is available (MCP session ID, OpenAI session, or transport
   * session ID), derives a deterministic Yavio session ID from it so that any
   * server instance processing the same key produces the same ID, and returns
   * that conversation's own state. Without a key: the connection's session.
   */
  const resolveSession = (sessionKey?: string): SessionState => {
    const key =
      sessionKey ??
      (currentMcpTransport && typeof currentMcpTransport.sessionId === "string"
        ? (currentMcpTransport.sessionId as string)
        : undefined);
    if (!key) {
      activeSession = session;
      return session;
    }

    const sessionId = deriveSessionId(key);
    const known = sessions.get(sessionId); // a hit counts as use
    if (known) {
      activeSession = known;
      return known;
    }
    const state: SessionState = {
      sessionId,
      userId: null,
      userTraits: {},
      platform: session.platform,
      stepSequence: 0,
    };
    sessions.set(sessionId, state);
    activeSession = state;
    return state;
  };

  // `tool()` exists on MCP SDK v1 only; v2 (`@modelcontextprotocol/server`)
  // has `registerTool()` alone, and binding a missing method was the crash
  // every v2 integrator hit (#133).
  const originalTool =
    typeof server.tool === "function"
      ? (server.tool as (...a: unknown[]) => unknown).bind(server)
      : undefined;
  const originalRegisterTool = (server.registerTool as (...a: unknown[]) => unknown).bind(server);
  const originalConnect = (server.connect as (...a: unknown[]) => Promise<unknown>).bind(server);

  /**
   * Keep fluent chains on the proxy.
   *
   * Skybridge's fluent methods (`registerTool`/`registerWidget`) return `this`
   * (the underlying server) so calls can be chained. Because the intercepting
   * functions below call methods bound to the underlying server, they would
   * return that server directly — dropping the rest of the chain off the proxy,
   * so only the first chained `registerTool` would be instrumented. When the
   * underlying call returns the server itself, return the proxy instead so every
   * chained registration stays intercepted. Plain MCP SDK `registerTool`/`tool`
   * return a `RegisteredTool` (not the server), which passes through unchanged.
   */
  const chainable = (result: unknown, receiver: unknown): unknown =>
    result === server ? receiver : result;

  /**
   * A tool_discovery event. The description is clamped to ingest's limit
   * (2048) — a longer one got the whole event rejected.
   */
  const discoveryEvent = (
    toolName: string,
    description: string | undefined,
    inputSchema: Record<string, unknown> | undefined,
  ) =>
    buildToolDiscoveryEvent(
      {
        traceId: generateTraceId(),
        sessionId: (activeSession ?? session).sessionId,
        sdkVersion,
        platform: (activeSession ?? session).platform,
      },
      { toolName, description: description?.slice(0, MAX_DISCOVERY_DESCRIPTION), inputSchema },
    );
  const emitDiscovery = (
    toolName: string,
    description: string | undefined,
    inputSchema: Record<string, unknown> | undefined,
  ) => transport.send([discoveryEvent(toolName, description, inputSchema)]);

  /**
   * Tools registered BEFORE the wrap (#133), `createYavio().wrap()` only. A
   * stateless host builds the server — tools included — and wraps the
   * finished server, so the interceptors below never see those
   * registrations. Instrument them in place through
   * `RegisteredTool.update({ callback })`, public API on every supported MCP
   * SDK (v1 since the floor, v2), exactly as the interceptors would have:
   * same callback wrapper, same capture flags, same intent classification.
   * `update()` is the only way on v2, whose tools/call executor captured the
   * handler at registration; it also sends `notifications/tools/list_changed`
   * when the server is already connected — one per tool, harmless (a
   * per-request host wraps before it connects). Task tools (the handler is an
   * object, not a function) stay out, as they do for the interceptors. A tool
   * the integrator registers on the UNWRAPPED server after wrapping is still
   * untracked. One tool whose update throws is skipped, not the rest.
   */
  const instrumentRegisteredTools = (): void => {
    let tools: Record<string, RegisteredToolLike> | undefined;
    try {
      tools = (server as unknown as { _registeredTools?: Record<string, RegisteredToolLike> })
        ._registeredTools;
    } catch {
      return; // Registry unreadable: nothing to instrument, the interceptors still work.
    }
    if (!tools || typeof tools !== "object") return;
    for (const name of Object.keys(tools)) {
      try {
        const tool = tools[name];
        if (!tool || typeof tool !== "object" || instrumentedTools.has(name)) continue;
        const handler = tool.handler;
        if (typeof handler !== "function" || typeof tool.update !== "function") continue;
        tool.update({
          callback: wrapToolCallback(
            handler as (...cbArgs: unknown[]) => unknown,
            name,
            resolveSession,
            server,
            config,
            resolveToolCapture(config, name),
            transport,
            sdkVersion,
          ),
        });
        // Only once the wrapper is in place: a tool whose update threw must
        // not count as instrumented (a frame would then be opened for it).
        // Intent classification of these tools was seeded by intent.attach()
        // from the same registry entries; nothing to note here.
        instrumentedTools.add(name);
        if (!protocolInstalled && !discoveryEmitted(name)) {
          markDiscovery(name);
          emitDiscovery(
            name,
            typeof tool.description === "string" ? tool.description : undefined,
            extractParamKeys(tool.inputSchema),
          );
        }
      } catch {
        // This tool stays as it was; the next one is still instrumented.
      }
    }
  };
  if (options.instrumentExisting) instrumentRegisteredTools();

  const proxy = new Proxy<T>(server, {
    get(target, prop, receiver) {
      if (prop === "tool" && originalTool) {
        return (...args: unknown[]) => {
          const cbIndex = args.findIndex((a) => typeof a === "function");
          if (cbIndex === -1) {
            return originalTool(...args);
          }

          const originalCb = args[cbIndex] as (...cbArgs: unknown[]) => unknown;
          const toolName = typeof args[0] === "string" ? args[0] : "unknown";
          intent?.noteToolRegistration(
            toolName,
            args.filter((a, i) => i > 0 && i < cbIndex && typeof a === "object" && a !== null),
          );
          instrumentedTools.add(toolName);
          args[cbIndex] = wrapToolCallback(
            originalCb,
            toolName,
            resolveSession,
            server,
            config,
            resolveToolCapture(config, toolName),
            transport,
            sdkVersion,
          );

          const result = originalTool(...args);

          // Fallback when tools/list could not be wrapped (see discoveryWrapper):
          // emit at registration, once per tool name, with property names only.
          if (!protocolInstalled && !discoveryEmitted(toolName)) {
            markDiscovery(toolName);
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

          return chainable(result, receiver);
        };
      }

      if (prop === "registerTool") {
        return (...args: unknown[]) => {
          // Two calling conventions reach this interceptor:
          //   MCP SDK:   registerTool(name, config, cb) — name at args[0], cb at args[2]
          //   Skybridge: registerTool(config, cb) — name on config.name, cb at args[1]
          // Locate the callback by type and the config by shape so both forms
          // (and mixes of them) are instrumented.
          const cbIndex = args.findIndex((a) => typeof a === "function");
          const configArg = args.find(
            (a, i) => (cbIndex === -1 || i < cbIndex) && typeof a === "object" && a !== null,
          ) as Record<string, unknown> | undefined;
          const toolName =
            typeof args[0] === "string"
              ? args[0]
              : typeof configArg?.name === "string"
                ? configArg.name
                : "unknown";
          // Pass the config's `_meta` too: MCP SDK versions before 1.18.0
          // accept it here but drop it before the registry and tools/list, so
          // this interceptor is the only place the widget-invokability signal
          // is guaranteed to be visible on every supported version.
          intent?.noteToolRegistration(
            toolName,
            configArg?.inputSchema ? [configArg.inputSchema] : [],
            configArg?._meta,
          );
          if (cbIndex !== -1) {
            const originalCb = args[cbIndex] as (...cbArgs: unknown[]) => unknown;
            instrumentedTools.add(toolName);
            args[cbIndex] = wrapToolCallback(
              originalCb,
              toolName,
              resolveSession,
              server,
              config,
              resolveToolCapture(config, toolName),
              transport,
              sdkVersion,
            );
          }

          const result = originalRegisterTool(...args);

          // Fallback when tools/list could not be wrapped (see discoveryWrapper).
          // Property names only: the raw inputSchema is a Zod object, and
          // serialising it ships Zod's internal state, not a schema (#83).
          if (cbIndex !== -1 && !protocolInstalled && !discoveryEmitted(toolName)) {
            markDiscovery(toolName);
            emitDiscovery(
              toolName,
              typeof configArg?.description === "string" ? configArg.description : undefined,
              extractParamKeys(configArg?.inputSchema),
            );
          }

          return chainable(result, receiver);
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
          activeSession = null;

          const result = await originalConnect(mcpTransport);

          // Connection event is deferred to the first tool call (see wrapToolCallback)
          // so that OpenAI's per-tool-call reconnects don't produce duplicate events.

          return result;
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  });
  const record: ExistingProxy = {
    proxy,
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    instrumentExisting: options.instrumentExisting === true,
    fingerprint: configFingerprint(config),
  };
  proxiesByServer.set(server, record);
  proxiesByServer.set(proxy, record);
  return proxy;
}

/** The registry entry of an MCP SDK v1 or v2 tool, as far as the proxy reads it. */
interface RegisteredToolLike {
  handler?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  _meta?: unknown;
  update?: (updates: { callback: unknown }) => unknown;
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

const MAX_DISCOVERY_DESCRIPTION = 2048;
const MAX_DISCOVERY_SCHEMA_LENGTH = 16_384;

/**
 * A listed tool's `inputSchema` as sent on tool_discovery: a detached copy (the
 * listing object is shared with the response and the intent wrapper), or
 * undefined when it is not a plain object. Longer than 16,384 characters
 * serialised — a giant enum is not worth an oversized event — it degrades to
 * the property names, like the registration-time fallback: ingest stores a
 * missing schema as `{}`, which would replace whatever the registry had.
 */
function listedInputSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const json = JSON.stringify(schema);
  if (json.length > MAX_DISCOVERY_SCHEMA_LENGTH) {
    const properties = (schema as { properties?: unknown }).properties;
    const names =
      properties && typeof properties === "object" && !Array.isArray(properties)
        ? Object.keys(properties)
        : [];
    return { type: "object", properties: Object.fromEntries(names.map((name) => [name, {}])) };
  }
  return JSON.parse(json) as Record<string, unknown>;
}

/** `undefined` for a missing or empty object, so an event never carries `{}`. */
function nonEmpty(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return value && Object.keys(value).length > 0 ? value : undefined;
}

/**
 * The parameter names a registered tool's input schema declares, for a
 * rejected call whose values are not kept (#123). Undefined for an unknown
 * tool or a schema whose top-level keys cannot be read (union, refine,
 * passthrough-only): no names are stored then at all, since a key the model
 * invented can carry free text as well as a value can. Reads McpServer's
 * registry the way the intent controller does (shapeHasContext).
 */
function declaredParamNames(server: McpServerLike, toolName: string): Set<string> | undefined {
  try {
    const tools = (
      server as unknown as { _registeredTools?: Record<string, { inputSchema?: unknown }> }
    )._registeredTools;
    if (!tools || !Object.hasOwn(tools, toolName)) return undefined;
    const schema = tools[toolName]?.inputSchema;
    if (!schema || typeof schema !== "object") return undefined;
    const obj = schema as Record<string, unknown>;
    if (obj.properties && typeof obj.properties === "object") {
      return new Set(Object.keys(obj.properties as object)); // JSON Schema
    }
    if ("_def" in obj || "_zod" in obj) {
      const raw =
        obj.shape ??
        (obj._zod as { def?: { shape?: unknown } } | undefined)?.def?.shape ??
        (obj._def as { shape?: unknown } | undefined)?.shape;
      const shape = typeof raw === "function" ? (raw as () => unknown)() : raw;
      return shape && typeof shape === "object" ? new Set(Object.keys(shape as object)) : undefined;
    }
    // A raw Zod shape: every value is a Zod type.
    const values = Object.values(obj);
    const isShape =
      values.length > 0 &&
      values.every((v) => !!v && typeof v === "object" && ("_def" in v || "_zod" in v));
    return isShape ? new Set(Object.keys(obj)) : undefined;
  } catch {
    return undefined;
  }
}

/** Only the declared keys of `args` (their values are dropped by the callers). */
function pickDeclared(args: unknown, names: Set<string> | undefined): Record<string, unknown> {
  if (!names || !args || typeof args !== "object" || Array.isArray(args)) return {};
  return Object.fromEntries(
    Object.entries(args as Record<string, unknown>).filter(([key]) => names.has(key)),
  );
}

/**
 * McpServer's texts for a call rejected before the handler, kept without
 * rejectedInputValues only when they hold nothing but the tool's own name
 * (#123): unknown, disabled, task misconfiguration. An argument-validation
 * text is replaced by a fixed reason, since Zod 3 echoes the rejected value
 * into it. Anything else — a wording a later MCP SDK introduces — is
 * dropped: fail closed.
 *
 * @internal Exported for its unit tests only; not part of the package API.
 */
export function valueFreeRejection(
  message: string | undefined,
  toolName: string,
): string | undefined {
  if (!message) return undefined;
  const text = message.replace(/^MCP error -?\d+: /, "");
  const named = (suffix: RegExp) => {
    const m = text.match(new RegExp(`^Tool (.+) (${suffix.source})$`));
    return m !== null && m[1] === toolName;
  };
  if (
    named(/not found/) ||
    named(/disabled/) ||
    named(/has taskSupport '\w+' but was not registered with registerToolTask/) ||
    named(/requires task augmentation \(taskSupport: 'required'\)/)
  ) {
    return message;
  }
  if (text.startsWith("Input validation error:")) {
    return "Input validation error: the arguments did not match the tool's schema (values not stored, see capture.rejectedInputValues)";
  }
  return undefined;
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
 * Deep-clone tool arguments and merge the parts of RequestHandlerExtra worth
 * keeping, under `_`-prefixed keys so they cannot collide with arguments:
 *
 * - `_meta`: the request `_meta` verbatim. On ChatGPT that is the richest
 *   client context there is (user agent, locale, location, subject, session,
 *   capabilities) and it is wanted as such — a product decision, 2026-08-26.
 *   It deliberately DUPLICATES what extractClientMeta lifts into the
 *   first-class `subject_id` / `locale` / `end_user_agent` / `country_code`
 *   / `region` columns; do not "deduplicate" either side away. Every
 *   `capture.geo` other than `true` is applied by reduceMeta: off, the
 *   `openai/userLocation` object (city, region, timezone, coordinates) is
 *   removed from the clone — a flag named geo must not leave coordinates
 *   in; `"country"` / `"region"` replace it with a NEW `{ country }` /
 *   `{ country, region }` object; and of the rest only the known keys stay
 *   (KNOWN_META_KEYS). The clone is what makes this safe: the handler's own
 *   `_meta` is never touched.
 * - `_metaDroppedKeys` / `_metaDroppedUnnamed`: under a `geo` other than
 *   `true`, the names (never the values) of the `_meta` keys reduceMeta
 *   dropped, so a new key shows up, and the count of those it does not name.
 * - `_taskId`: MCP task id, for correlating task-based flows.
 * - `_requestInfo`: allow-listed headers and the URL sans query, see
 *   sanitizeRequestInfo.
 *
 * Dropped in 0.4.0 after an inventory (input-values-extra-fields.md):
 * `_requestId` (a per-connection counter, on ~every call, says nothing),
 * `_taskRequestedTtl` (never seen), and `_sessionId` — the RAW Mcp-Session-Id
 * while the `session_id` column is hashed on purpose, empirically absent
 * fleet-wide (stateless transports), and exactly the kind of identifier an
 * app-store review flags.
 */
function extractInputValues(
  args: unknown,
  extra: unknown,
  geo: CaptureConfig["geo"],
): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  try {
    const clone = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
    const ex = readCallExtra(extra);
    if (ex.meta) {
      const meta = JSON.parse(JSON.stringify(ex.meta)) as unknown;
      if (geo !== true && meta && typeof meta === "object" && !Array.isArray(meta)) {
        const reduced = reduceMeta(meta as Record<string, unknown>, geo);
        clone._meta = reduced.meta;
        if (reduced.droppedKeys.length > 0) clone._metaDroppedKeys = reduced.droppedKeys;
        if (reduced.droppedUnnamed > 0) clone._metaDroppedUnnamed = reduced.droppedUnnamed;
      } else {
        clone._meta = meta;
      }
    }
    if (ex.taskId) clone._taskId = ex.taskId;
    if (ex.requestHeaders || ex.requestUrl) {
      const requestInfo = sanitizeRequestInfo(ex.requestHeaders, ex.requestUrl);
      if (requestInfo) clone._requestInfo = requestInfo;
    }
    return clone;
  } catch {
    return undefined;
  }
}

/**
 * The top-level `_meta` keys kept under a `capture.geo` other than `true`,
 * besides `openai/userLocation`, which is rebuilt. Everything else is dropped:
 * the conversation and request ids ChatGPT sends (`sessionId`, `windowId`,
 * `callId`, `itemId`, `openai/request_id`), `traceparent`,
 * `openai/organization`, the client capabilities, the top-level `timezone`
 * and `timezone_offset_minutes`, and any key the platform adds later.
 *
 * An allowlist, not a denylist (#127): ChatGPT added seven undocumented
 * top-level keys between 2026-09 and 2026-10, one of them location data, and
 * nothing makes the next one carry a recognisable name. The four kept here
 * are the ones a "country"/"region"/false integration documents to its users:
 * language, device, and the platform's pseudonymous user and conversation ids.
 * The names of dropped keys are recorded (see reduceMeta), never their values.
 */
const KNOWN_META_KEYS = new Set([
  "openai/locale",
  "openai/userAgent",
  "openai/subject",
  "openai/session",
]);

/**
 * A key name worth recording as dropped: the MCP `_meta` key format
 * (optional dot-separated prefix and `/`, then a name of letters, digits and
 * `._-`), at most 64 characters, and no run of 8 or more hex digits — such a
 * name can carry an id or a token, so it is counted, not named.
 */
const RECORDABLE_KEY =
  /^(?:[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\/)?[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const ID_LIKE_RUN = /[0-9A-Fa-f]{8,}/;
const MAX_DROPPED_KEYS = 20;

function recordable(key: string): boolean {
  return key.length <= 64 && RECORDABLE_KEY.test(key) && !ID_LIKE_RUN.test(key);
}

/**
 * The request `_meta` (a clone) under a `capture.geo` other than `true`.
 *
 * - `openai/userLocation` is rebuilt from an allow-list, so a field the
 *   platform adds later cannot leak through: `{ country }` for `"country"`,
 *   `{ country, region }` for `"region"` (`{ country }` when there is no
 *   valid region), and removed for `false` or when there is no valid country.
 * - Every other key is kept only if it is in KNOWN_META_KEYS.
 * - `droppedKeys`: the names (never the values) of what went, sorted, at most
 *   MAX_DROPPED_KEYS; `droppedUnnamed`: how many dropped keys are not named —
 *   an id-like or malformed name, or one past the cap.
 */
function reduceMeta(
  meta: Record<string, unknown>,
  geo: "country" | "region" | false,
): { meta: Record<string, unknown>; droppedKeys: string[]; droppedUnnamed: number } {
  const kept: Record<string, unknown> = {};
  const named: string[] = [];
  let unnamed = 0;
  for (const [key, value] of Object.entries(meta)) {
    if (KNOWN_META_KEYS.has(key)) kept[key] = value;
    else if (key === "openai/userLocation") continue;
    else if (recordable(key)) named.push(key);
    else unnamed++;
  }
  named.sort();
  const location = meta["openai/userLocation"];
  const country = geo === "country" || geo === "region" ? locationCountry(location) : undefined;
  if (country) {
    const region = geo === "region" ? locationRegion(location, country) : undefined;
    kept["openai/userLocation"] = region ? { country, region } : { country };
  }
  return {
    meta: kept,
    droppedKeys: named.slice(0, MAX_DROPPED_KEYS),
    droppedUnnamed: unnamed + Math.max(named.length - MAX_DROPPED_KEYS, 0),
  };
}

/**
 * Request headers kept on an event. Everything else is dropped.
 *
 * An allowlist, not a denylist: the header map is written by whoever calls the
 * MCP server, so a denylist can only ever exclude the credential names we
 * thought of. `Authorization`, `Cookie`, `X-Api-Key` and friends must never
 * reach analytics, and `X-Forwarded-For` would put an end-user IP on an event
 * that is otherwise anonymous.
 *
 * The first two survive because they answer questions the dashboard actually
 * asks — which client called (beyond the coarse `platform` field) and in which
 * language — and neither identifies a person. The README lists all five; keep
 * it in step.
 */
const CAPTURED_HEADERS = new Set([
  "user-agent",
  "accept-language",
  // Anthropic's surface marker ("ClaudeAI", "Cowork") — the trustworthy way
  // to tell Claude surfaces apart, verified in live traffic 2026-07-29.
  "x-anthropic-client",
  // Wire protocol version and W3C trace context for log correlation.
  // None of these carry personal data.
  "mcp-protocol-version",
  "traceparent",
]);

/**
 * Extract client metadata the platform relays in request `_meta` into
 * first-class event fields. Purely a restructuring of data that already
 * arrives on every call — nothing is requested from the client. ChatGPT
 * sends all of these; platforms that send none produce undefined.
 *
 * The location part is gated behind `capture.geo` and reduced to the
 * 2-letter country code plus, with `true` or `"region"`, the region name —
 * city, timezone and coordinates are never lifted into a first-class column.
 * (They do travel inside the verbatim `_meta` clone in `input_values` while
 * `geo` is `true`; otherwise reduceMeta cuts that object down to the same
 * country and region, or drops it.)
 */
function extractClientMeta(
  extra: unknown,
  geo: CaptureConfig["geo"],
): import("../core/events.js").ClientMeta | undefined {
  const m = readCallExtra(extra).meta;
  if (!m) return undefined;

  const str = (v: unknown, max: number): string | undefined =>
    typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined;

  const location = m["openai/userLocation"];
  // Exact values, not truthiness: a geo that skipped resolveGeo (a string
  // "false") must not count as on.
  const countryCode =
    geo === true || geo === "country" || geo === "region" ? locationCountry(location) : undefined;
  const out = {
    countryCode,
    region: geo === true || geo === "region" ? locationRegion(location, countryCode) : undefined,
    locale: str(m["openai/locale"], 35),
    endUserAgent: str(m["openai/userAgent"], 512),
    subjectId: str(m["openai/subject"], 256),
  };
  return out.countryCode || out.locale || out.endUserAgent || out.subjectId ? out : undefined;
}

/**
 * The upper-cased ISO alpha-2 country of an `openai/userLocation` object, or
 * undefined. The single check behind both `country_code` and the
 * `"country"` / `"region"` reduction of `_meta`, so the two can never disagree.
 */
function locationCountry(location: unknown): string | undefined {
  if (!location || typeof location !== "object") return undefined;
  const country = (location as Record<string, unknown>).country;
  return typeof country === "string" && /^[A-Za-z]{2}$/.test(country)
    ? country.toUpperCase()
    : undefined;
}

/**
 * The `region` of an `openai/userLocation` object through
 * normalizeRegionName() — the rule ingest applies too (@yavio/shared/geo):
 * NFC, apostrophes and dashes folded, at most 64 characters, letters and a
 * little punctuation, no digits — or undefined. Only next to the valid
 * country the caller has already checked: a region without its country says
 * nothing. The single check behind both the `region` field and the
 * `"region"` reduction of `_meta`. Not mapped to ISO 3166-2.
 */
function locationRegion(location: unknown, country: string | undefined): string | undefined {
  if (!country || !location || typeof location !== "object") return undefined;
  const region = (location as Record<string, unknown>).region;
  return typeof region === "string" ? (normalizeRegionName(region) ?? undefined) : undefined;
}

/**
 * Reduce the HTTP request info (v1 `RequestHandlerExtra.requestInfo`, v2
 * `ctx.http.req`, both read by extra.ts) to the parts that are safe to store:
 * allowlisted headers, and the URL without its query string (query params are
 * a common place for tokens).
 *
 * Returns undefined when nothing survives, so the event carries no empty shell.
 */
function sanitizeRequestInfo(
  rawHeaders: Record<string, unknown> | undefined,
  url: string | undefined,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};

  if (rawHeaders) {
    const headers: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(rawHeaders)) {
      // Node lowercases incoming header names, but the shape is only typed as a
      // plain object — normalize so a hand-built `Authorization` cannot slip by.
      if (!CAPTURED_HEADERS.has(name.toLowerCase())) continue;
      if (typeof value === "string") headers[name.toLowerCase()] = value;
      else if (Array.isArray(value)) headers[name.toLowerCase()] = value.join(", ");
    }
    if (Object.keys(headers).length > 0) out.headers = headers;
  }

  if (typeof url === "string") {
    const [withoutFragment] = url.split("#");
    const [withoutQuery] = withoutFragment.split("?");
    if (withoutQuery) out.url = withoutQuery;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Is this CallToolResult a tool-reported failure? Only the literal boolean
 * `true` counts — MCP types `isError` as boolean, and PostHog's
 * `isToolResultError()` applies the same rule. `"true"`, `1` or a missing flag
 * are not errors.
 *
 * Returns the first text content item as the message (the text is what the
 * handler told the model went wrong), or no message when there is none.
 * Redaction and the length clamp happen in buildToolCallEvent.
 */
function toolResultError(result: unknown): { message?: string } | null {
  if (!result || typeof result !== "object") return null;
  const res = result as Record<string, unknown>;
  if (res.isError !== true) return null;
  if (!Array.isArray(res.content)) return {};
  for (const item of res.content) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === "text" && typeof entry.text === "string") {
      return { message: entry.text };
    }
  }
  return {};
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
