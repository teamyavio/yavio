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
