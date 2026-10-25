import type { SessionSource } from "@yavio/shared/events";

/** How the SDK derived a session id (#144); the list lives in @yavio/shared. */
export type { SessionSource };

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
  /**
   * How long a `flush()` waits for ingest, in milliseconds (#171): the
   * option, `YAVIO_FLUSH_TIMEOUT_MS` or `.yaviorc.json`, else 1 s. Always
   * set by `resolveConfig()`; optional for configs built by hand (tests),
   * which get the default. Not part of the process deadline a signal
   * fixes, and not part of `configFingerprint()`: a flush is not a
   * shutdown, and the bound is per client.
   */
  flushTimeoutMs?: number;
  /**
   * How long the flush `flushWhenSent()` hands to `waitUntil` may keep
   * waiting for the batch it sent, in milliseconds (#171 review round 2):
   * the option, `YAVIO_WAIT_UNTIL_TIMEOUT_MS` or `.yaviorc.json`, else
   * 10 s. Optional like `flushTimeoutMs`; not in `configFingerprint()`.
   */
  waitUntilTimeoutMs?: number;
  /**
   * The integrator's session key for calls that carry no key the SDK knows
   * (#144), when one was given and is a function. Code option only.
   */
  sessionKey?: SessionKeyFunction;
}

/** The configuration source `shutdownTimeoutMs` was read from. */
export type ShutdownTimeoutSource = "option" | "env" | "file" | "default";

/**
 * What the host's auth middleware attached to the request (`req.auth`), as
 * the MCP SDK passes it on: v1 `extra.authInfo`, v2 `ctx.http.authInfo`.
 * The fields are the MCP SDK's `AuthInfo`; what `extra` holds is the
 * integrator's own layout.
 */
export interface SessionKeyAuthInfo {
  readonly token?: string;
  /** The OAuth client — shared by every user of a client app: never a session key on its own. */
  readonly clientId?: string;
  readonly scopes?: readonly string[];
  readonly expiresAt?: number;
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

/**
 * What `sessionKey` receives for one tool call (#144) — the same shape on
 * MCP SDK v1 and v2.
 */
export interface SessionKeyRequest {
  /**
   * The HTTP request's headers, names lower-cased, a repeated header's
   * values joined with `", "`. `{}` off HTTP (stdio, in-memory).
   */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The request `_meta`, `{}` when the client sent none. */
  readonly meta: Readonly<Record<string, unknown>>;
  /** What the host's auth middleware set as `req.auth`; undefined without one. */
  readonly authInfo: SessionKeyAuthInfo | undefined;
  /** The handler context as the MCP SDK passed it (v1 `RequestHandlerExtra`, v2 `ctx`). */
  readonly extra: unknown;
}

/**
 * Returns the key of the conversation a call belongs to, or undefined (or
 * `""`) when there is none. Synchronous; called on the hot path before the
 * tool handler, only for calls that carry no session key the SDK knows.
 * The SDK stores a keyed hash of the value, never the value itself.
 */
export type SessionKeyFunction = (request: SessionKeyRequest) => string | undefined;

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
   * `SIGTERM` after the `SIGINT` that started the drain — Claude Code's stop
   * sequence for a stdio server — moves that deadline in to SIGINT +
   * 400 ms when that is sooner, and a higher value does not extend it
   * (#175, 0.5.6). A participant that sets none does not lower D; `YAVIO_SHUTDOWN_TIMEOUT_MS`
   * counts even with no participant live. Rule of thumb: the close cap of
   * your handler + 1 s, and both inside the platform's grace period (Fly.io
   * 5 s, Cloud Run 10 s, Kubernetes and ECS 30 s). A process that ends on
   * its own with events queued (no signal, no `shutdown()`: a stdio server
   * whose client closed stdin) drains within min(1.5 s, D): a lower value
   * lowers that bound, a higher one does not raise it (#167).
   */
  shutdownTimeoutMs?: number;
  /**
   * How long `flush()` (and `flushWhenSent()`) waits for ingest: an
   * integer number of milliseconds in [100, 2147483647] (default 1 000;
   * env `YAVIO_FLUSH_TIMEOUT_MS`; anything else logs `YAVIO-1006` once and
   * uses the default). Keep it well inside the function's own timeout
   * when you `await` the flush before returning — AWS Lambda's default is
   * 3 s: a slow or unreachable ingest costs at most this much per
   * invocation. Nothing is dropped at this deadline: what is undelivered
   * stays queued for the next flush. During a `SIGTERM`/`SIGINT` the flush
   * ends by the process deadline instead, when that comes first (#171).
   */
  flushTimeoutMs?: number;
  /**
   * How long the flush `flushWhenSent()` hands to the platform's
   * `waitUntil` may keep waiting for the batch it sent, past
   * `flushTimeoutMs`: an integer number of milliseconds in [100,
   * 2147483647] (default 10 000; env `YAVIO_WAIT_UNTIL_TIMEOUT_MS`;
   * anything else logs `YAVIO-1006` once and uses the default). That flush
   * delays no response, and on Cloudflare Workers a fetch dies with its
   * request once the flush ends, so an ingest slower than
   * `flushTimeoutMs` would never have its batches answered. Only the
   * flush with a fetch of its own out waits, and no other flush takes that
   * batch back meanwhile; once it is answered, the flush also sends the
   * events of concurrent requests whose flushes gave up waiting on it,
   * while a round trip still fits (review rounds 3 and 4). A fetch gives up at its 30 s timeout anyway.
   * Workers allow 30 s of `waitUntil` after the response; on Vercel the
   * function runs as long as it waits, so lower it there if an ingest that
   * hangs must not cost more (#171 review round 2).
   */
  waitUntilTimeoutMs?: number;
  /**
   * The conversation a call belongs to, for clients that send no session key
   * the SDK knows (#144). Over HTTP, on any host, every such call is
   * otherwise a session of its own (`session_source: "per_request"`, not
   * counted as a session). Called only when the call carries none of, in this order,
   * `Mcp-Session-Id`, `_meta["openai/session"]`, `_meta["vscode.conversationId"]`
   * and the Codex CLI's `_meta.threadId`:
   *
   * ```ts
   * sessionKey: ({ headers }) => headers["x-conversation-id"],
   * ```
   *
   * Return a CONVERSATION id: funnels, paths, the step sequence and
   * `identify()` work per session, and a session keeps its first identified
   * user. Never return a per-user id on its own (an auth subject would chain
   * all of that user's conversations into one endless session), the OAuth
   * `clientId` (shared by every user of a client app), the bearer token, a
   * constant, or a per-request id. Synchronous, at most 1 024 characters;
   * `undefined` or `""` means no key. A throw, a non-string, a promise or a
   * longer string counts as no key too, with one `YAVIO-1102` warning per
   * process. The SDK stores `ses_` + an HMAC of the value keyed with the API
   * key, never the value. Code option only (a function); anything else logs
   * `YAVIO-1006` once and is ignored.
   */
  sessionKey?: SessionKeyFunction;
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
   * deadline gives up is counted in one `YAVIO-1205` line (one more when
   * the signal was handed back before the transport stops had settled: at
   * the deadline when a `shutdown()` is still waiting then, otherwise once
   * they have settled). The transport stops once no other client with the
   * same configuration holds it — on a key a `withYavio()` call pinned too,
   * where a fresh transport takes over at once so those servers keep
   * sending (#179, 0.5.6; before, that release only drained); a later wrap
   * by this client holds it again, or starts a fresh one. A call made while the SDK's natural-exit drain runs (from an
   * app `beforeExit` listener registered after the SDK's) waits for that
   * drain, which ends within min(1.5 s, D) whatever this client's own
   * value (#167): to wait longer, call it before the event loop empties.
   * It is for the end of the process, not for every request: on a host
   * that freezes the instance after the response, use `flush()`.
   */
  shutdown(): Promise<void>;
  /**
   * Send everything queued now and wait until ingest has answered, for
   * runtimes that freeze or throttle the instance once the response is
   * out: AWS Lambda, Vercel Functions, Cloudflare Workers, Cloud Run with
   * request-based billing, Netlify Functions (#171). Where the platform has
   * a `waitUntil`, hand it the flush once the response body has been sent
   * — `flushWhenSent()` does that for a web-standard response; where it
   * has none, `await analytics.flush()` once the response body is complete
   * and before the handler returns.
   *
   * Resolves once nothing that was queued or in flight at the call is
   * left; or once a batch failed and waits for a retry that ends past the
   * deadline — a batch waiting for its retry is retried at once when its
   * last attempt is at least a second old, once per flush, a `Retry-After`
   * is never cut, and the retry after that goes on in the background; or
   * at `flushTimeoutMs`
   * (1 s by default) from the call. Never rejects and never drops: what it
   * could not deliver stays queued for the next flush, the flush interval
   * or `shutdown()`, with one `YAVIO-1208` line until a flush delivers
   * everything again, at most one a minute (a second stall within it is
   * reported by the first flush after the minute if it still lasts then;
   * one that ends within the minute prints nothing); not from a flush that
   * gave up waiting on another running flush's batch, which reports for it.
   * Events queued after the call are the next flush's. A fetch an earlier
   * request left in flight, older
   * than `flushTimeoutMs` (twice that each time the batch is taken back,
   * and at least twice ingest's last round trip) — after a freeze its
   * connection is likely dead, on Cloudflare Workers it never settles once
   * its request has ended — is taken back and its batch re-sent unchanged.
   * If the first copy reached ingest after all, ingest stores both:
   * ClickHouse drops the second when it makes up an insert block of its
   * own, otherwise the ReplacingMergeTree collapses them at merge time,
   * and until then a query without `FINAL` counts the event twice.
   *
   * Keeps this client's hold, the transport and its timer, so the next
   * request's `wrap()` finds the same transport, and arms no exit report.
   * The transport is shared per endpoint and API key: a flush sends the
   * events of every request and client on that key, and concurrent flushes
   * share the batches — each event goes out once. During a signal cycle it
   * ends by the process deadline when that comes first. In no-op mode it
   * resolves at once.
   */
  flush(): Promise<void>;
  /**
   * `flush()` once a web-standard response has been sent, handed to the
   * platform's `waitUntil` (#171): Vercel's `waitUntil` from
   * `@vercel/functions` (or Next.js's `after`), or a context that has one
   * — Cloudflare's `ctx`, Netlify's `context` — passed as the object, so
   * its `waitUntil` is called as its method (workerd throws "Illegal
   * invocation" for a `ctx.waitUntil` called on its own; a bound function
   * works too). Returns the response to send instead of
   * `response`: the same status, status text and headers, its body piped
   * through, so the flush starts once the body has been read to its end
   * — or cancelled, the client gone. A streamed MCP response (Server-Sent
   * Events, what most clients get from MCP SDK v2's `createMcpHandler`)
   * resolves `handler.fetch()` before the tool call has ended and queued
   * its event, so a `waitUntil(analytics.flush())` right after `fetch()`
   * flushes too early and every call's event waits for the next
   * invocation. A response without a body (or one already read) is
   * returned as it is and flushed at once. Past `flushTimeoutMs`, the
   * flush keeps waiting for the batch it sent, up to `waitUntilTimeoutMs`
   * (10 s): it delays no response, and on Workers a fetch dies with its
   * request once the flush ends. `waitUntil` is called once,
   * synchronously, with a promise that never rejects; if it throws, the
   * response is still returned and the flush runs without it (one line).
   * In no-op mode it returns `response` untouched.
   */
  flushWhenSent(response: Response, waitUntil: WaitUntil): Response;
}

/**
 * Where `flushWhenSent()` hands its flush (#171): a `waitUntil` function
 * (Vercel's from `@vercel/functions`, Next.js's `after`), or a context
 * object whose `waitUntil` method is called on it (Cloudflare Workers'
 * `ctx`, Netlify's `context`).
 */
export type WaitUntil =
  | ((promise: Promise<unknown>) => void)
  | { waitUntil(promise: Promise<unknown>): void };

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
  /**
   * How `sessionId` was derived (#144), stamped on every event of the
   * session as `session_source`. Set when a keyed session or a key-less HTTP
   * call's own session (`per_request`, #169) is created; the connection's own
   * session is labelled `connection` by the first key-less call off HTTP.
   */
  sessionSource?: SessionSource;
}
