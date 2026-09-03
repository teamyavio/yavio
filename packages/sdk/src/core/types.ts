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
}

/**
 * Per-tool overrides of the capture flags. A key that is omitted inherits the
 * global `capture` value. Lets a tool with sensitive input (an IBAN, a message
 * body) stay on the instrumented server — keeping latency, status, intent and
 * the `yavio.*` tracking context — while the SDK guarantees what is not
 * captured for it.
 */
export interface ToolCaptureOverride {
  /**
   * `false`: no `input_keys`, `input_types`, `input_values` and no client
   * metadata (`locale`, `country_code`, `end_user_agent`, `subject_id`) for
   * this tool, on success and on error. Same semantics as the global flag.
   */
  inputValues?: boolean;
  /**
   * `false`: no `output_content` for this tool, and no `error_message` taken
   * from an `isError` result (that text is output). `status` and
   * `error_category` are still recorded; a thrown error's message still is.
   */
  outputValues?: boolean;
  /**
   * `false`: the `context` parameter is neither advertised nor captured for
   * this tool. A `context` a client still sends (cached schema) is stripped
   * before validation, so strict schemas keep accepting the call. Has no
   * effect while intent capture is off globally.
   */
  intent?: boolean;
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
  geo: boolean;
  tokens: boolean;
  retries: boolean;
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
  platform: string;
  stepSequence: number;
}
