/** Resolved SDK configuration after discovery. */
export interface YavioConfig {
  apiKey: string;
  endpoint: string;
  capture: CaptureConfig;
  /**
   * When true, the SDK runs in server-only mode: no `_meta.yavio` is injected
   * into tool results and no widget token is minted. Server-side event capture
   * (`tool_call`, `tool_discovery`, `connection`) and the `yavio.*` tracking
   * API still work unchanged.
   */
  serverOnly: boolean;
  intent: IntentConfig;
  /** Per-tool overrides of the capture flags, keyed by tool name. Empty when none. */
  tools: Record<string, ToolCaptureOverride>;
  /**
   * How long a drain may take, in milliseconds: this client's `shutdown()`
   * gives up at this deadline, and so does the SDK's signal drain of a
   * transport this configuration created (#142). Resolved once per client,
   * not per proxy.
   */
  shutdownTimeoutMs: number;
  /**
   * Where `shutdownTimeoutMs` came from: the code option, the env var
   * `YAVIO_SHUTDOWN_TIMEOUT_MS`, `.yaviorc.json`, or the default when none
   * of them set it (a rejected value counts as unset — it logged
   * `YAVIO-1006` and the default applies). The signal drain is bounded only
   * by values set explicitly: a participant on the default adds no bound
   * (#142 review round 3).
   */
  shutdownTimeoutMsSource: ShutdownTimeoutSource;
}

/** The configuration source `shutdownTimeoutMs` was read from. */
export type ShutdownTimeoutSource = "option" | "env" | "file" | "default";

/**
 * Per-tool overrides of the capture flags. A key that is omitted inherits the
 * global `capture` value. Lets a tool with sensitive input (an IBAN, a message
 * body) stay on the instrumented server — keeping latency, status, intent and
 * the `yavio.*` tracking context — while the SDK guarantees what is not
 * captured for it.
 */
export interface ToolCaptureOverride {
  /**
   * `false`: no `input_keys`, `input_types`, `input_values`, no client
   * metadata (`locale`, `country_code`, `region`, `end_user_agent`,
   * `subject_id`) and no
   * thrown error's message (messages tend to interpolate the arguments) for
   * this tool, on success and on error. Same semantics as the global flag.
   */
  inputValues?: boolean;
  /**
   * `false`: no `output_content` for this tool, and no `error_message` taken
   * from an `isError` result (that text is output). `status` and
   * `error_category` are still recorded; a thrown error's message still is
   * (gated on `inputValues` instead).
   */
  outputValues?: boolean;
  /**
   * `false`: the `context` parameter is neither advertised nor captured for
   * this tool. A `context` a client still sends (cached schema) is stripped
   * before validation, so strict schemas keep accepting the call. Has no
   * effect while intent capture is off globally.
   */
  intent?: boolean;
  /**
   * `true`: a call rejected before the handler ran (arguments the schema
   * rejected, unknown or disabled tool) keeps its argument values and
   * McpServer's error text. Same semantics as the global flag (#123).
   */
  rejectedInputValues?: boolean;
}

/** Resolved user-intent capture configuration. */
export interface IntentConfig {
  enabled: boolean;
  /** Advertise the `context` parameter as required in tools/list. */
  required: boolean;
  /** Description shown to the calling model for the `context` parameter. */
  description: string;
  /**
   * Called for eligible tool calls that arrive without a `context` argument.
   * Return a short intent string to capture it with source "inferred", or
   * undefined to capture nothing. Errors are swallowed.
   *
   * Runs on the hot path BEFORE the tool handler, and its duration is not
   * included in the call's latency_ms — keep it fast and synchronous; do not
   * call out to an LLM or network service here.
   */
  fallback?: (
    toolName: string,
    args: Record<string, unknown> | undefined,
  ) => string | undefined | Promise<string | undefined>;
}

/** User-facing intent options on `withYavio()`. */
export interface IntentOptions {
  required?: boolean;
  description?: string;
  fallback?: IntentConfig["fallback"];
}

/** Controls which auto-captured data is included. */
export interface CaptureConfig {
  inputValues: boolean;
  outputValues: boolean;
  /**
   * Location the platform relays in `_meta["openai/userLocation"]` (and, on
   * ChatGPT, the IANA zone in the top-level `_meta.timezone`).
   * - `true` (default): `country_code` and `region` are set and
   *   `input_values._meta` stays whole (city, region, country, timezone,
   *   coordinates).
   * - `"region"`: `country_code` and `region` are set; `input_values._meta`
   *   keeps only `{ country, region }` and loses `timezone` — nothing else,
   *   including fields added later.
   * - `"country"`: `country_code` is set; `input_values._meta` keeps only
   *   `{ country }` and loses `timezone`.
   * - `false`: neither field, and both the object and `timezone` are removed
   *   from `_meta`.
   */
  geo: boolean | "country" | "region";
  tokens: boolean;
  retries: boolean;
  /**
   * Argument values of a call rejected before the handler ran: arguments the
   * tool's schema rejected, an unknown or a disabled tool (#123).
   * - `false` (default): the event keeps `status`, `error_category:
   *   "validation"`, the names and types (`input_keys`, `input_types`) of the
   *   parameters the tool's schema declares, the `_`-prefixed request context
   *   in `input_values`, the client metadata and a value-free reason in
   *   `error_message` — but no argument values, no key the model invented and
   *   no `output_content`. McpServer's error text can echo the rejected value,
   *   so it is kept as-is only when it names nothing but the tool.
   *   A successful call only ever stores values the schema accepted, so a
   *   tool whose arguments are all enums stores only fixed values.
   * - `true`: the raw arguments and the error text are stored, to see what
   *   the model sent. Whatever the model put into a field is then kept,
   *   free text from the conversation included.
   * No effect while `inputValues` is off: nothing of the input is captured.
   */
  rejectedInputValues: boolean;
}

/** Options passed to `withYavio()`. */
export interface WithYavioOptions {
  apiKey?: string;
  endpoint?: string;
  capture?: Partial<CaptureConfig>;
  /**
   * Run in server-only mode. Skips `_meta.yavio` injection and widget token
   * minting; the tool result returned to the MCP client is identical to what
   * the handler returned. Server-side events are still emitted.
   *
   * Note: The React widget (`useYavio()`) relies on `_meta.yavio` to
   * self-configure, so it will not auto-connect when `serverOnly` is true.
   */
  serverOnly?: boolean;
  /**
   * User intent capture. Off by default. Pass `true` to advertise a required
   * `context` parameter on every tool so the calling model states why it is
   * invoking the tool; the value is captured as the call's intent and removed
   * before your handler runs. Pass an object to tune requiredness, the
   * model-facing description, or a fallback for clients that never send it.
   *
   * Privacy note: intent text is derived from the end user's conversation.
   * If you submit your server to the ChatGPT App Store or Claude Directory,
   * disclose this collection in your privacy policy or leave intent capture
   * disabled.
   */
  intent?: boolean | IntentOptions;
  /**
   * Per-tool overrides of the `capture` flags, keyed by tool name:
   *
   * ```ts
   * tools: { "book-contract": { inputValues: false, outputValues: false, intent: false } }
   * ```
   *
   * Prefer this over registering a sensitive tool on the unwrapped server —
   * that loses the `tool_call` event and turns `yavio.conversion()` and
   * friends into no-ops for the tool. Names are not validated (tools register
   * after `withYavio()` runs); an override for a tool that never registers is
   * simply unused. Also readable from `.yaviorc.json` as `"tools"`.
   */
  tools?: Record<string, ToolCaptureOverride>;
  /**
   * The deadline for delivering what is queued when the process shuts down:
   * an integer number of milliseconds in [100, 2147483647] (default 4 000
   * since 0.5.3; env `YAVIO_SHUTDOWN_TIMEOUT_MS`; anything else logs
   * `YAVIO-1006` once and uses the default). Outside a signal it bounds this
   * client's `shutdown()` from its call. On `SIGTERM`/`SIGINT` the SDK fixes
   * one deadline for the whole process at signal + D, where D is the
   * smallest value set explicitly (option, `YAVIO_SHUTDOWN_TIMEOUT_MS` or
   * `.yaviorc.json`) by any `createYavio()` client, `withYavio()` call or
   * `shutdown()` still running when the signal arrives, else the default;
   * the SDK's drain and every `shutdown()` at or after the signal resolve by
   * then, however long the handler's close before it took (#148). A
   * participant that sets none does not lower D; `YAVIO_SHUTDOWN_TIMEOUT_MS`
   * counts even with no participant live. Rule of thumb: the close cap of
   * your handler + 1 s, and both inside the platform's grace period (Fly.io
   * 5 s, Cloud Run 10 s, Kubernetes and ECS 30 s).
   */
  shutdownTimeoutMs?: number;
}

/**
 * An MCP server the SDK can instrument, by shape (#133): the MCP SDK v1
 * `McpServer` (`@modelcontextprotocol/sdk`) and the v2 `McpServer`
 * (`@modelcontextprotocol/server`) both satisfy it. `registerTool` and
 * `connect` are the two methods every supported generation has; `tool()`
 * exists on v1 only and is intercepted when present; `server` is the
 * low-level server the protocol layer patches when it can.
 *
 * Structural on purpose: the SDK has no runtime import of either MCP package,
 * and a nominal type would tie an integrator to one of them.
 */
export interface McpServerLike {
  registerTool: (...args: never[]) => unknown;
  connect: (...args: never[]) => Promise<unknown>;
  tool?: (...args: never[]) => unknown;
  server?: unknown;
}

/**
 * A configured Yavio client: the process-level half of the SDK (resolved
 * config, the HTTP transport to ingest, the shared session store, the
 * shutdown hooks). `wrap()` is the per-server half, cheap enough to run on
 * every request of a stateless host. See `createYavio()`.
 */
export interface YavioClient {
  /**
   * Instrument a server: every tool on it, including those registered before
   * the wrap. Synchronous. Returns the server unchanged in no-op mode (no API
   * key) and for a server shape the SDK does not support (`YAVIO-1107`,
   * logged once per process), and the existing proxy for a server that is
   * already wrapped.
   */
  wrap<T extends McpServerLike>(server: T): T;
  /**
   * Deliver everything queued before the call, then release this client's
   * hold on the shared transport. Resolves only once ingest has the events —
   * including what the SDK's own `SIGTERM`/`SIGINT` listener is still
   * draining when the call is made from the app's signal handler, and what a
   * request finishing after the signal sent (#142). A second or concurrent
   * call waits for the first. Bounded by this client's own
   * `shutdownTimeoutMs` from the call — the drain and the transport stop it
   * causes run under that deadline too, not under the deadline of whoever
   * created the shared transport — and, once a signal fixed the process
   * deadline (signal + D, see `shutdownTimeoutMs`), by that deadline: a call
   * running at or after the signal resolves by then, one with no time left
   * at once, and one after the hand-back waits at most D (#148). What the
   * deadline gives up is counted in one `YAVIO-1205` line. The transport
   * stops only when no other client with the same configuration holds it
   * and no `withYavio()` call pinned it; a later wrap by this client holds
   * it again, or starts a fresh one.
   */
  shutdown(): Promise<void>;
}

/** The tracking context available via the `yavio` singleton. */
export interface YavioContext {
  identify(userId: string, traits?: Record<string, unknown>): void;
  step(name: string, meta?: Record<string, unknown>): void;
  track(event: string, properties?: Record<string, unknown>): void;
  conversion(
    name: string,
    data: { value: number; currency: string; meta?: Record<string, unknown> },
  ): void;
}

/** Session state stored per MCP connection. */
export interface SessionState {
  sessionId: string;
  userId: string | null;
  userTraits: Record<string, unknown>;
  /**
   * The stable JSON of `[user_id, user_traits]` of the last `identify`
   * event this state sent: a repeat with the same id and traits sends
   * nothing (#145). Unset on a fresh state — a new conversation, one the
   * LRU evicted, another process — which therefore sends once.
   */
  identified?: string;
  platform: string;
  stepSequence: number;
}
