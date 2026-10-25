# 3. Server SDK

## 3.1 The withYavio() Proxy

The primary integration point. Accepts an `McpServer` instance and returns a proxied version that auto-instruments all tool calls and pushes events to the Yavio ingestion API.

### 3.1.1 Developer-Facing API

```typescript
import { withYavio } from "@yavio/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const server = new McpServer({ name: "hotel-booking", version: "1.0.0" });

const instrumented = withYavio(server, {
  // Required: project API key from Yavio dashboard
  apiKey: process.env.YAVIO_API_KEY,

  // Optional: ingestion endpoint (defaults to Yavio Cloud)
  endpoint: "https://your-self-hosted-instance.com/v1/events",

  // Optional: disable specific auto-capture features
  capture: {
    inputValues: true,  // full input values + client metadata (PII-stripped)
    outputValues: true, // full tool results
    geo: true,         // true | "region" | "country" | false: country code, region, location in _meta
    tokens: true,      // reserved — no effect today
    retries: true,     // reserved — no effect today (is_retry is never set)
  },

  // Optional: per-tool overrides of the capture flags, merged over `capture`.
  // See per-tool-capture.md. Also readable from .yaviorc.json as "tools".
  tools: {
    "book-contract": { inputValues: false, outputValues: false, intent: false },
  },

  // Optional: the deadline for delivering queued events on shutdown (#142,
  // #148). An integer in [100, 2147483647] ms, default 4 s; env
  // YAVIO_SHUTDOWN_TIMEOUT_MS; also readable from .yaviorc.json. Anything
  // outside the range is one YAVIO-1006 warning and the default. Bounds
  // this client's shutdown() from its call; on SIGTERM/SIGINT one process
  // deadline at signal + D, D the smallest value set explicitly (option, env
  // or file) by any client, withYavio() call or shutdown() in progress —
  // unset participants do not lower it; with nothing set, 4 s.
  shutdownTimeoutMs: 4_000,

  // Optional (#171, 0.5.5): how long createYavio().flush() and
  // flushWhenSent() wait for ingest. An integer in [100, 2147483647] ms,
  // default 1 s; env YAVIO_FLUSH_TIMEOUT_MS; also readable from
  // .yaviorc.json; anything else is one YAVIO-1006 warning and the default.
  // Cut to what a signal cycle leaves; not counted towards D; nothing is
  // dropped at it. Past it, flushWhenSent()'s flush still waits for the
  // batch it sent, up to waitUntilTimeoutMs (below).
  flushTimeoutMs: 1_000,

  // Optional (#171 review round 2): how long the flush flushWhenSent() hands
  // to waitUntil may keep waiting, past flushTimeoutMs, for the batch it
  // sent: it delays no response, and on Workers a fetch dies with its
  // request once that flush ends. Default 10 s; env
  // YAVIO_WAIT_UNTIL_TIMEOUT_MS; .yaviorc.json; YAVIO-1006 as above.
  waitUntilTimeoutMs: 10_000,

  // Optional (#144, 0.5.4): the conversation of a call that carries no
  // session key the SDK knows (see 3.7.1). Code only; synchronous; returns a
  // conversation id (never a per-user id alone, the OAuth clientId, the
  // bearer token, a constant or a per-request id), at most 1 024 characters,
  // or undefined. Stored as a keyed hash. A non-function: YAVIO-1006 once.
  sessionKey: ({ headers }) => headers["x-conversation-id"],
});
```

`createYavio(options)` takes the same options and returns a client: `wrap(server)` per request, `shutdown()` at the end of the process, and — for runtimes that freeze or throttle the instance once the response is out (AWS Lambda, Vercel Functions, Cloudflare Workers, Cloud Run with request-based billing, Netlify Functions; #171, 0.5.5) — `flush()` and `flushWhenSent()`:

```typescript
const analytics = createYavio({ serverOnly: true });
const mcp = createMcpHandler(() => analytics.wrap(buildServer()));

// No waitUntil (AWS Lambda, Cloud Run with request-based billing): flush
// once the body is complete, before the handler returns.
const response = await mcp.fetch(request);
const body = await response.text();
await analytics.flush();

// A waitUntil (Vercel, Cloudflare Workers, Netlify): flush once the body
// has been sent — a function, or a context whose waitUntil is called on it.
return analytics.flushWhenSent(await mcp.fetch(request), ctx);
```

`flush(): Promise<void>` sends everything queued for the client's endpoint and API key at the call — every request's and every client's on that key — and resolves once ingest has answered what was queued or in flight at the call (what is queued later is the next flush's, review round 4), once a batch waits for a retry that ends past the deadline, or at `flushTimeoutMs`. It never rejects and never drops, keeps the hold and the transport, arms no exit report, and prints one `YAVIO-1208` per stall, at most one per key a minute (a second stall within it is reported by the first flush after the minute that still leaves events undelivered and does not defer; one that ends within the minute prints nothing), and none from a flush that ended `deferred` to another running flush's send. `flushWhenSent(response, waitUntil): Response` returns the response with its body piped through and hands `waitUntil` a flush that starts once the body has been read to its end or cancelled: a streamed MCP response resolves `fetch()` before the tool call has ended and queued its event. Both resolve at once in no-op mode (`flushWhenSent` returns the response untouched). The README's "Serverless and edge runtimes" section has the per-platform recipes; [per-request-servers.md](./per-request-servers.md) has the measurements.

### 3.1.2 Config Discovery

`withYavio()` resolves configuration in priority order:

1. **Code options:** Values passed directly to `withYavio(server, { apiKey, endpoint })`. Highest priority. `sessionKey` exists only here (a function).
2. **Environment variables:** `YAVIO_API_KEY` and `YAVIO_ENDPOINT` (also `YAVIO_SERVER_ONLY`, `YAVIO_INTENT`, `YAVIO_SHUTDOWN_TIMEOUT_MS`). Used when code options are not provided.
3. **`.yaviorc.json`:** Reads `apiKey` and `endpoint` from the nearest `.yaviorc.json` file (walks up from `process.cwd()`). Lowest priority. Created by `yavio init`.

If no API key is found through any source, `withYavio()` logs a warning and returns a transparent pass-through proxy that does not capture any events. This prevents crashes in environments where analytics is not configured.

### 3.1.3 Proxy Internals

The proxy uses JavaScript `Proxy` to intercept method calls on the `McpServer` instance. The key interception points are:

- **`server.tool()` and `server.registerTool()` registration:** Intercepts both the deprecated `tool()` method and the modern `registerTool()` method (MCP SDK v1.26+) to capture tool names, descriptions, and schemas. Wraps the handler function with identical instrumentation via a shared `wrapToolCallback()` helper. For `tool()`, the callback is located by scanning for the first function argument (handles all overloads). For `registerTool()`, the callback is always the 3rd positional argument.
- **Tool handler execution:** Before/after hooks capture invocation timestamp, measure latency, catch errors, detect platform, and capture full input values and derive input patterns. A handler that asks for input (MCP SDK v2 `inputRequired()`, a result with `resultType: "input_required"`) runs once per round; a round that asks sends no event and its result passes through untouched, and the call's one `tool_call` comes from the round whose result is final, with `metadata.input_rounds` / `input_retry` and the rounds' summed handler time (0.5.5, #168, [protocol-layer-status.md](./protocol-layer-status.md#multi-round-trip-calls-168-055)).
- **`server.connect()` / transport:** Intercepts transport connection to keep a reference to the MCP transport (its `sessionId`, when it has one, is the first session key) and to start the connection's own session. The `session_id` of a call is derived per `tools/call` (see [Section 3.7](#37-session-lifecycle)); nothing is read from `initialize`, which a per-request instance never sees.
- **`tools/list` requests:** Wraps the low-level `tools/list` handler and sends one `tool_discovery` per instrumented tool per process, carrying the JSON Schema the client was shown (#83). Listing frequency is not recorded.
- **`initialize` requests (#170, 0.5.5):** A read-only tap on the low-level `initialize` handler records the protocol version the server answered with, the connection event's `protocol_version` where neither a 2026-07-28 envelope nor an `mcp-protocol-version` header names one (stdio, in-memory); the handshake's result and errors are unchanged ([protocol-layer-status.md](./protocol-layer-status.md)). The names of the client's declared capabilities, never their values, go on the connection event as `metadata.client_capabilities`.
- **Tool response inspection:** After the handler returns, the proxy inspects the response content. Captures response size (bytes), content type distribution (text/image/resource), result count for list-type responses, and detects zero-result responses via empty array and "no results" text heuristics.

#### Abstraction Layer

Internally, the proxy delegates to an `InstrumentationLayer` interface. In v1 this is `ProxyInstrumentation`. The interface is designed so a `TransportInstrumentation` (wrapping stdin/stdout or HTTP at the JSON-RPC level) can be added in v2 for Python SDK support without changing any downstream code.

### 3.1.4 Auto-Captured Telemetry

For the complete list of server-side auto-captured events and their fields, see [metrics/events.md](metrics/events.md#server-side-auto-captured).

## 3.2 Explicit Tracking API

For business-level telemetry that the proxy cannot infer automatically, developers use explicit methods available via context injection or the module singleton.

### 3.2.1 Context Injection (Primary)

`withYavio()` enriches the context object that MCP tool handlers receive. The `yavio` instance on context is automatically scoped to the current request, inheriting traceId, platform, tool name, and session.

```typescript
// Using registerTool (recommended, MCP SDK v1.26+)
server.registerTool("book_room", {
  description: "Book a hotel room",
  inputSchema: { userId: z.string(), roomType: z.string() },
}, async (params) => {
  // User identification: tie this session to a known user
  yavio.identify(params.userId, { plan: "premium", country: "DE" });

  const rooms = await searchRooms(params);

  // Funnel step: mark progress through a user journey
  yavio.step("rooms_found", { count: rooms.length });

  // Custom event: track anything not auto-captured
  yavio.track("cache_hit", { provider: "memory" });

  const booking = await confirmBooking(rooms[0]);

  // Conversion: revenue attribution
  yavio.conversion("booking_completed", {
    value: booking.price,
    currency: "EUR",
  });

  return booking;
});

// The deprecated tool() API is also supported
server.tool("book_room", async (params) => {
  yavio.identify(params.userId);
  // ...
});
```

### 3.2.2 Module Singleton (Secondary)

For use in utility functions deep in the call stack where the context object is not available. Uses Node.js `AsyncLocalStorage` internally to resolve the current request context.

```typescript
import { yavio } from "@yavio/sdk";

// In a utility function called from within a tool handler:
function processPayment(userId: string, amount: number) {
  // Works because AsyncLocalStorage propagates through async calls
  yavio.identify(userId, { lifetimeValue: amount });
  yavio.track("payment_processed", { gateway: "stripe" });
  yavio.conversion("payment", { value: amount, currency: "EUR" });
}

// Outside any request context the call has no session or trace to attach to:
// the event is DROPPED and the SDK warns once per process (YAVIO-1105).
// Register the tool through withYavio() — with a `tools` override if its
// input must not be captured — rather than on the unwrapped server.
yavio.track("server_started", { version: "1.0.0" }); // dropped
```

### 3.2.3 Method Signatures

| Method | Signature | Description |
|--------|-----------|-------------|
| `.identify()` | `identify(userId: string, traits?: Record<string, unknown>)` | Ties the current session and all subsequent events to a known user. Traits travel on the `identify` event (no dashboard code reads `user_traits` yet). Enables retention and per-user analytics. One `identify` event per session state (0.5.4, #145, see 3.2.4). |
| `.step()` | `step(name: string, meta?: Record<string, unknown>)` | Marks a funnel step. Each step receives an auto-incrementing `step_sequence`, per session in each process (it starts again at 1 on another instance and after an LRU eviction; the dashboard orders a session's steps by time and uses it as the tie-breaker, #145). Powers the combined funnel visualization. |
| `.track()` | `track(event: string, properties?: Record<string, unknown>)` | Generic custom event. Escape hatch for anything not auto-captured or not a funnel step. |
| `.conversion()` | `conversion(name: string, data: { value: number; currency: string; meta?: Record<string, unknown> })` | Revenue attribution event. Value and currency are required. Powers ROI analytics. |

> **PII Stripping:** PII redaction uses a defense-in-depth strategy across two layers. The **SDK** runs a lightweight, non-configurable best-effort pass (`core/pii.ts`) that strips common PII patterns (emails, credit cards, SSNs, phone numbers) from event payloads before they leave the process. The **ingestion API** then runs a full configurable scrub as the authoritative safety net before writing to ClickHouse. Both layers are ON by default and not configurable in v1. Both return a string that is exactly a valid W3C `traceparent` unchanged (0.5.5, #173; `traceparentOf()` in `core/trace-context.ts`, mirrored in ingest's `lib/pii-stripper.ts`): 55 characters of lower-case hex in fixed positions, version not `ff`, neither id all zeros. It is random and has no room for PII, but its ids end in ten decimal digits often enough (~1.9 %) for the phone pattern to cut them. A string that merely contains one is stripped as before.

### 3.2.4 Identify Behavior

`.identify(userId, traits?)` associates the current session with a known user:

- **userId** is a developer-provided string (e.g., database ID, external ID). It is NOT stripped by PII — it is the developer's chosen identifier.
- **traits** are optional key-value pairs describing the user (e.g., `{ plan: "pro", company: "Acme" }`). Traits are PII-stripped like all other metadata.
- Calling `.identify()` emits an `identify` event and sets `user_id` on all subsequent events in the current session (server-side via AsyncLocalStorage, widget-side via the singleton). Server-side, since 0.5.4 (#145), only when `[user_id, user_traits]` of the event, as stable JSON (keys sorted at every level, `core/stable.ts`), differs from the last one this session state sent (`SessionState.identified`): a repeat with the same id and traits sends nothing, a changed trait sends the merged traits, a trait with no JSON form (a BigInt) sends every time and keeps no fingerprint. A fresh state — a new conversation, one the LRU evicted, another process — sends once, and the read side takes a session's first identify. The one-user-per-session check (`YAVIO-1302`, next bullet) is per process and best effort for the same reason. The widget hook keeps its own rule (one event per call).
- Multiple `.identify()` calls in the same session update the traits (merge, not replace). The `userId` cannot change within a session — a second call with a different `userId` logs a warning and is ignored.
- Events emitted before `.identify()` in a session will have `user_id = null`, and so will the session's events on every other process of a stateless fleet. The read side stitches them (#145): the dashboard and the #85 statistics job map each `session_id` to the `user_id` of its first `identify` event at query time and count the session's unstamped events for that user (an event's own `user_id` wins); see [storage-layer.md §5.1.4](../infrastructure/storage-layer.md#514-sessions-and-users-no-materialized-views).

## 3.3 HTTP Batch Transport

The SDK buffers events in memory and flushes them to the Yavio ingestion API in batches. This ensures zero impact on tool call latency.

### 3.3.1 Transport Behavior

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Flush interval | 10 seconds, armed by the first `send()` after `start()` (since 0.5.5, #171) | Balances delivery latency with batch efficiency. Armed lazily because Cloudflare Workers forbid timers outside a request: a module-scope `createYavio()` failed to load there; in Node only the phase changes |
| Max batch size | 100 events | Triggers early flush if buffer fills before interval |
| Max buffer size | 10,000 events | Prevents memory exhaustion under extreme load. Oldest dropped with warning. |
| Retry strategy | Exponential backoff: 1s, 2s, 4s, 8s, 16s (max 5 retries) | Handles transient network/ingestion failures |
| Shutdown | Drain on `SIGTERM`/`SIGINT` within one process deadline at signal + D (`shutdownTimeoutMs`, 4 s by default; the smallest value set explicitly in the process), print one `YAVIO-1205` line with the count if the deadline gave events up, then hand the signal back | The SDK removes its listeners after draining and re-raises the signal when nothing else listens, so the default exit (130/143) happens as without the SDK; an app with its own handler keeps control (#138) |
| Natural exit | On `beforeExit` with events queued — no signal, no `shutdown()`: a stdio server whose client closed stdin, a script or CLI, a host that closed its server without a signal — stop every live transport within min(1.5 s, D) and print what that deadline gave up in one `YAVIO-1205` line at exit (`Exit deadline of 1500 ms reached — N events not delivered …`) | One listener per process, installed with the first transport. A lower explicit `shutdownTimeoutMs` lowers the bound, a higher one does not raise it (the MCP TypeScript clients send `SIGTERM` 2 s after closing stdin). With nothing queued it returns at once: no delay, no line. A signal during the drain takes its stops over without extending them; an app's `shutdown()` called meanwhile waits for it. `process.exit()`, a signal's default exit and an uncaught exception emit no `beforeExit` and are unchanged. Before 0.5.5 the queue went with the process, without a line (#167) |
| Log lines | Every SDK line goes to stderr (`console.warn`, `console.error`, `writeStderrLine`), the informational ones included | On a stdio server stdout is the JSON-RPC wire; before 0.5.5 the `Server-only mode`, `Intent capture enabled`, widget-override, re-wrap, signal and 207 notes went to stdout through `console.info`/`console.debug`, and the client got a parse error for each (#174) |
| `client.shutdown()` | Delivers everything queued before the call, then releases the client's hold; resolves once ingest answered or at the client's own `shutdownTimeoutMs` | Awaits the signal drain already running and the transport a request finishing after the signal sent through, so the app handler `await http.close(cb); await shutdown(); process.exit(0)` exits with nothing in flight; a second or concurrent call waits for the first; `HttpTransport.shutdown()` is idempotent (#142). Outside a signal the deadline is per call: `HttpTransport.shutdown(deadlineMs)` / `drain(deadlineMs)` take the calling client's value, whichever client or `withYavio()` call created the shared transport (review round 1). The drain the SDK starts on `SIGTERM`/`SIGINT` is bounded by the smallest value set explicitly (option, `YAVIO_SHUTDOWN_TIMEOUT_MS` or `.yaviorc.json`) by any client or `withYavio()` call for the key; unset participants do not lower it (`resolveConfig()` reports `shutdownTimeoutMsSource`, and the registry ignores `"default"`, review round 3); with nothing set, the default. Since 0.5.3 (#148) that bound is one process deadline at signal + D, taken across every key, hold, pin and `shutdown()` in progress (the env var counts even with none live), else 4 s: the drain, every release drain and every `shutdown()` at or after the signal resolve by it, one with no time left at once, one after the hand-back within D of its call; at the deadline the transport aborts its fetch, schedules no wait past it and counts the loss (one `YAVIO-1205` line per cycle, before the re-raise; one at exit for an app that exits early). The grace period is per process, so the strictest bound wins; `YAVIO_SHUTDOWN_TIMEOUT_MS` counts as explicit for every participant in the process, so it sets one value for all of them (review round 2) |
| `client.flush()` | Sends what is queued for the key at the call and waits for ingest to answer it, bounded by `flushTimeoutMs` (1 s by default; cut to what a signal cycle leaves, released by its deadline timer) | For hosts that freeze after the response (#171, 0.5.5). `HttpTransport.flushQueued(deadlineMs, staleAfterMs)`, next to `drain()`: C1 batches one at a time, nothing dropped or aborted at the deadline; C2 a batch waiting for its retry (5xx, network error, 429 without `Retry-After`) retried at once when its last attempt is at least `BASE_RETRY_DELAY_MS` old, once per flush, not counted towards `maxRetries`, its failure without a `YAVIO-1200` line; a `Retry-After` (429 or 5xx) never cut; a wait whose end passed without its timer running sent now and counted; a later retry wait watched only if it ends before the deadline; C3 a fetch an earlier flush left in flight for longer than `staleAfter()` — the budget × 2^(times the batch was taken back), at least twice the last round trip, capped at the fetch timeout — taken back and its batch re-sent first and unchanged (`resend`), not counted. Taking a batch back (`abandon()`) marks the send abandoned and clears the in-flight slot without waiting for anything the send created: on Cloudflare Workers a fetch or timer of a request that has ended never settles, and a promise it created that another request resolves has its continuations cancelled (review round 1). A flush's waits are bounded by timers of its own (`watch`). `flushShared()` first awaits `signalDrain` and the key's stops in progress; its deadline timers are ref'd while it runs (#164's rule). One `YAVIO-1208` per stall per key (`stalledFlushes`), none while draining after a signal. Keeps the hold and the transport, arms no exit report, not counted towards D. `flushWhenSent(response, waitUntil)` runs it once the body has been sent, and past `flushTimeoutMs` keeps waiting for the fetch it started or re-sent itself, up to `waitUntilTimeoutMs` (`flushQueued`'s `holdMs`, review round 2). No other flush takes back a send whose flush still runs (`owned`, round 3). Once its batch is answered, the holding flush sends what is queued next, while a round trip as long as the last one still fits. It returns `deadline` if it ends with events queued. A hold is armed only when `holdMs > deadlineMs` and more than 5 ms are left. `flushShared()`'s own race comes due 25 ms after the transport's deadline. The stale bound's round-trip floor is at most four budgets, and a round trip longer than the fetch timeout (a freeze) is not sampled. `drain()` waits for the in-flight slot (`slotChange`), not for the send's promise, which never settles once a flush takes the batch back. It is bounded by the batches it starts, not by its rounds (round 3) |
| Fetch | `globalThis.fetch.bind(globalThis)` unless the `fetch` option is given (since 0.5.5, #171) | Cloudflare's workerd rejects a fetch called with another `this` ("Illegal invocation"); called as `this._fetch(…)`, every batch failed there |
| Authentication | `Authorization: Bearer <projectApiKey>` header | Stateless, validated by ingestion API against PostgreSQL. Server SDK always uses the project API key directly (JWTs are only for widget-side auth). |

### 3.3.2 Request Format

```http
POST /v1/events HTTP/1.1
Host: ingest.yavio.ai
Authorization: Bearer yav_abc123...
Content-Type: application/json

{
  "events": [
    {
      "event_type": "tool_call",
      "event_name": "search_rooms",
      "timestamp": "2026-03-15T10:30:00.123Z",
      "trace_id": "tr_8f2a...",
      "session_id": "ses_x7k...",
      "platform": "chatgpt",
      "source": "server",
      "latency_ms": 234,
      "status": "success",
      "input_keys": ["checkin", "guests", "budget"],
      "input_types": {"checkin": "string", "guests": "number", "budget": "number"},
      "tokens_in": 150,
      "tokens_out": 420,
      "metadata": {}
    }
  ],
  "sdk_version": "1.0.0",
  "sent_at": "2026-03-15T10:30:10.000Z"
}
```

### 3.3.3 Response Handling

| Status | SDK Behavior |
|--------|-------------|
| `200 OK` | Batch accepted. Clear from buffer. |
| `207 Multi-Status` | Partial accept. Response body contains per-event errors with index and reason. Rejected events are logged and discarded — rejections are caused by schema validation or field limit violations, which are deterministic and cannot be fixed by retrying. |
| `401 Unauthorized` | Invalid API key. Log error. Stop retrying (permanent failure). |
| `429 Too Many Requests` | Rate limited. Retry with backoff using `Retry-After` header. |
| `5xx` | Server error. Retry with exponential backoff. |
| Network error | Ingestion unreachable. Keep events in buffer. Retry on next flush cycle. |

## 3.4 Widget Configuration Injection

When a tool call returns, the server-side `withYavio()` proxy injects ingestion API configuration into the tool result's `_meta.yavio` field. The proxy mints a short-lived widget token via the ingestion API so that the project API key never leaves the server.

### 3.4.1 Widget Token Minting

After the tool handler returns, the proxy requests a short-lived JWT from the ingestion API:

```http
POST /v1/widget-tokens HTTP/1.1
Host: ingest.yavio.ai
Authorization: Bearer yav_abc123...
Content-Type: application/json

{ "traceId": "tr_8f2a...", "sessionId": "ses_abc..." }
```

Response:

```json
{
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "expiresAt": "2026-03-15T11:00:00Z"
}
```

The returned JWT is scoped to a single trace and session, and expires after 15 minutes. It grants write-only access to the ingestion API for that trace only. The `sessionId` is included in the JWT claims so the widget SDK can stamp all outgoing events with the server's session ID. The project API key is used to authenticate this request but is never forwarded to the widget.

If the token request fails (network error, invalid key), the proxy skips injection and the widget falls back to no-op mode.

#### Token Caching

The proxy caches the minted token and reuses it across tool calls within the same connection, refreshing only when the token is within 30 seconds of expiry. The cache is invalidated on:

- **Reconnect:** A new `connect()` call clears the cache, since the session and trace context change.
- **Auth failure:** A `401` or `403` response from the token endpoint clears the cache immediately, handling key rotation or revocation.

### 3.4.2 Injection into Tool Results

After the tool handler returns and a widget token is available, the proxy injects a `yavio` config object into the result's `_meta` field:

```json
{
  "content": [{ "type": "text", "text": "..." }],
  "_meta": {
    "yavio": {
      "token": "eyJhbGciOiJIUzI1NiJ9...",
      "endpoint": "https://ingest.yavio.ai/v1/events",
      "traceId": "tr_8f2a...",
      "sessionId": "ses_abc...",
      "sessionSource": "custom"
    }
  }
}
```

`sessionSource` (#144, 0.5.4) is the session's `session_source` label (3.7.1), never a key; the React SDK stamps it on every widget event so a `per_request` session's widget rows are excluded like its server rows. Omitted while the session has no label. A widget before 0.5.4 ignores it.

If the result already has a `_meta` object, the proxy preserves existing fields and adds `yavio` alongside them. If minting fails or the result is not an object, the result is returned unchanged. An `input_required` result (a round of a multi-round-trip call, MCP 2026-07-28, #168) is returned unchanged in every mode: no widget renders it, and the v2 client consumes it internally; the mint started for it is dropped unused, and the final round mints its own token.

The AI platform (e.g., ChatGPT, Claude) may surface `_meta.yavio` directly in the tool result or transform it into a top-level `.yavio` field in the response metadata (e.g., Skybridge). The React widget SDK handles both shapes (see [Section 4.3.2](react-widget-sdk.md#432-client-side-detection)).

### 3.4.3 Legacy: `window.__YAVIO__` Injection

For widget-serving setups where the server controls the HTML bundle, the `window.__YAVIO__` global remains supported as the highest-priority config source on the client side:

```javascript
// Injected by withYavio() into the widget bundle at serve time
window.__YAVIO__ = {
  token: "eyJhbGciOiJIUzI1NiJ9...",              // short-lived widget JWT (15 min)
  endpoint: "https://ingest.yavio.ai/v1/events", // ingestion API URL
  traceId: "tr_8f2a...",                          // current request trace
  sessionId: "ses_abc..."                          // server session (shared by widget)
};
```

> **Security Note:** The widget receives a short-lived JWT instead of the project API key. The JWT is trace-scoped (can only push events for the specific `traceId` it was minted for), expires after 15 minutes, and grants write-only access. Even if extracted from the browser iframe, the token is useless after expiry and cannot be used to send events for other traces. The project API key never leaves the server process.

## 3.5 Trace ID & Combined Funnel

The `traceId` is the correlation key that stitches server-side and widget-side events into a single end-to-end funnel. This cross-layer visibility is the unique product advantage.

### 3.5.1 Trace Lifecycle

1. User sends prompt to AI platform
2. AI platform invokes MCP tool → `withYavio()` proxy intercepts
3. Proxy generates traceId (e.g., `"tr_" + nanoid(21)`) and inherits `session_id` from the current MCP connection (see [Section 3.7](#37-session-lifecycle))
4. Proxy starts AsyncLocalStorage context with traceId and sessionId
5. Tool handler executes (`yavio.step()` calls inherit traceId via AsyncLocalStorage)
6. If tool returns widget: proxy calls `POST /v1/widget-tokens` with traceId and sessionId to mint a short-lived JWT
7. Proxy injects `window.__YAVIO__` with traceId + sessionId + widget JWT + endpoint (API key stays on server)
8. Widget renders in iframe, initializes `useYavio()` which reads `window.__YAVIO__`
9. Widget events sent directly to ingestion API with JWT auth and traceId in payload
10. Ingestion API verifies JWT, stores all events — same traceId forms one funnel in ClickHouse

The trace id is minted per `tools/call` request. A multi-round-trip call on MCP 2026-07-28 is several requests, so each round has its own trace, and only the final request's has a `tool_call`: a `track()` / `step()` / `conversion()` inside an earlier round carries a trace no `tool_call` has (#168, documented, not fixed). On v2's 2025-era shim every round runs inside one request and shares its trace.

### 3.5.2 Example Combined Funnel

| Step | Source | Event Type | Data |
|------|--------|------------|------|
| 1 | Server (auto) | tool_call | tool: "search_rooms", latency: 234ms |
| 2 | Server (explicit) | step | name: "rooms_found", count: 12 |
| 3 | Server (auto) | widget_response | resourceUri detected in response, widget token minted |
| 4 | Widget (auto) | widget_render | viewport: 400x600, widget initialized |
| 5 | Widget (hook) | step | name: "room_selected", roomType: "suite" |
| 6 | Widget (hook) | step | name: "details_completed" |
| 7 | Widget (hook) | conversion | name: "booking_completed", value: 567, currency: "EUR" |

## 3.6 Platform Detection

The SDK identifies which AI platform is invoking the MCP server. This powers cross-platform comparison analytics. Detection uses a layered heuristic approach:

| Priority | Signal | Platforms | Reliability |
|----------|--------|-----------|-------------|
| 1 | Transport protocol / connection metadata | ChatGPT (SSE with specific headers), Claude (MCP protocol version) | High |
| 2 | User-Agent or custom headers | Cursor, VS Code (distinctive UA strings) | High |
| 3 | Request origin / referrer | ChatGPT (openai.com), Claude (claude.ai) | Medium |
| 4 | Behavioral heuristics | Tool call patterns, parameter formats | Low (fallback) |

When detection is ambiguous, the SDK records the platform as `"unknown"` with all available signals stored for later reclassification. The detection module is designed as a pluggable strategy so new platforms can be added without changing core SDK code.

## 3.7 Session Lifecycle

An **analytics session** represents one conversation between a client (AI platform) and the instrumented server. It is derived **per `tools/call`** from the first conversation key the call carries (rewritten 2026-10-23, #144): a per-request host (stateless Streamable HTTP, a new `McpServer` per request) never sees `initialize` on the instance that serves the call, a stateless transport issues no `Mcp-Session-Id`, and the 2026-07-28 protocol era (SEP-2567) drops the header altogether — so neither the handshake nor the transport is a session boundary there.

### 3.7.1 Session Derivation

`openCallContext()` (`server/proxy.ts`) takes the first key of this table (`findSessionKey()`, `server/session-key.ts`), and every server event records which one in `session_source` (`@yavio/shared` `SESSION_SOURCES`, ClickHouse migration 0022):

| Order | Key | `session_id` | `session_source` |
|---|---|---|---|
| 1 | The transport's session id — `extra.sessionId` (v1) / `ctx.sessionId` (v2), else the connected transport's `sessionId` (`Mcp-Session-Id`) | `deriveSessionId(key)` | `mcp_session_id` |
| 2 | `_meta["openai/session"]` (ChatGPT) | `deriveSessionId(key)` | `openai_session` |
| 3 | `_meta["vscode.conversationId"]` (VS Code ≥ 1.105 / Copilot Chat), from any client | `deriveSessionId(key)` | `vscode_conversation` |
| 4 | `_meta.threadId`, only when the client is `codex-mcp-client` (envelope, `getClientVersion()` or User-Agent, the order of the connection event's client identity) — a bare `threadId` from an unknown client could merge users | `deriveSessionId(key)` | `codex_thread` |
| 5 | The integrator's `sessionKey(request)` option | `deriveCustomSessionId(apiKey, key)` | `custom` |
| — | None | On an HTTP request (`requestInfo` / `http.req` present): a new `"ses_" + nanoid(21)` for the call, not stored (0.5.5, #169). Otherwise the connection's own session (`"ses_" + nanoid(21)` on `connect()`, or `deriveSessionId(transport.sessionId)` when the transport had one by then) | `per_request` on an HTTP request, `connection` otherwise (stdio, in-memory) |

- `deriveSessionId(key)` = `"ses_"` + the first 21 base64url characters of SHA-256(key). `deriveCustomSessionId(apiKey, key)` = `"ses_"` + the first 21 base64url characters of HMAC-SHA256(apiKey, `"custom\0" + key`): an integrator may return an email or a user id, and an unkeyed hash of a guessable value is a pseudonym anyone can recompute. Both are deterministic across instances and processes; a custom session splits once when the API key is rotated. Empty strings are no key at every step.
- `sessionKey` gets `SessionKeyRequest = { headers, meta, authInfo, extra }`, the same on MCP SDK v1 and v2: the headers as a fresh record (names lower-cased, a repeated header's values joined with `", "`, `{}` off HTTP), the request `_meta` (`{}` without one), v1 `extra.authInfo` / v2 `ctx.http.authInfo` (what the host's middleware set as `req.auth`), and the raw handler context. It is called only when keys 1–4 are absent, at most once per call (the protocol-layer frame resolves the context once; the callback wrapper reuses it), synchronously, before the handler. `undefined` or `""` is no key. A throw, a non-string, a thenable (its rejection is caught: an unhandled one would end the process) or more than 1 024 characters is no key plus one `YAVIO-1102` warning per process — `openCallContext()` runs outside McpServer's own error handling, so nothing may escape it. A non-function option is one `YAVIO-1006` warning; code only (no env or file form). Its presence is part of the re-wrap fingerprint (1108).
- What to return is a **conversation** id: a session keeps its first identified user (1302) and funnels, paths and the step sequence are per session, so a per-user key (an auth subject) would chain all of a user's conversations into one session. `authInfo.clientId` is the OAuth client, shared by every user of a client app; the bearer token, a constant and a per-request id are wrong for the obvious reasons (#144, #145).
- The built-in keys apply on every transport: a VS Code stdio server moves from one session per client process (`connection`) to one per conversation.

All events of a call (tool calls, identify, steps, track, conversions, the connection event) inherit its session and `session_source`; `tool_discovery` stamps the session of the most recent call, or the connection's session before any call, and no `session_source`: ingest writes it to `tool_registry`, which keeps neither `session_id` nor `session_source` (review round 1 dropped a label the `tools/list` request used to put on the connection session).

### 3.7.2 Session Boundary Rules

| Rule | Behavior |
|------|----------|
| The same key on another request, instance or process | The same `session_id` (3.7.1). |
| A call without a key | Over HTTP a session of one call (`per_request`) on every host, including a long-lived server that reuses one MCP SDK v1 1.24/1.25 stateless transport (0.5.5, #169). Off HTTP the connection's session, one per client process on stdio (`connection`). |
| Transport reconnection without re-initialization | Continues the existing session. This applies to Streamable HTTP resumability (`Last-Event-ID` + same `Mcp-Session-Id`). |
| Transport disconnect | No event; the SDK sends no disconnect variant of `connection`. A session has no end event. |
| Multiple traces per session | Expected. A conversation typically holds multiple tool invocations, each with its own `trace_id`. |
| `userId` scope | Bound to the session. `.identify()` sets `user_id` for all subsequent events in the session, in that process. Cannot change within a session. In a `per_request` session it covers one call. |

**Many conversations through one proxy (added 2026-10-14, 0.4.0).** Stateless transports and OpenAI's per-call reconnects serve every conversation through one `withYavio()` proxy. The proxy therefore keeps session state — `session_id`, `userId`, traits, the step sequence, `session_source` — **per derived session id** (any key of 3.7.1), in a bounded map of 1,000 least-recently-used entries. Before, one shared session object was mutated per call: a user identified in conversation A appeared on conversation B's events, and two overlapping calls could swap session ids. Calls without any session key get a session of their own per call over HTTP (`per_request`, not stored in the map, #169) and use the connection's session off HTTP.

**Several processes (added 2026-10-21, 0.5.2, #142).** The connection-event dedup is per process: a conversation served by N instances of a stateless fleet, or restarted after an LRU eviction, has N `connection` rows with random ids and their own timestamps, which never collapse under `ReplacingMergeTree`. The event therefore means "this session connected, as seen by one process", at least once per session per process, and sessions are counted as `uniqExact(session_id)` over every event — never as connection rows — in every dashboard query, in the #85 statistics job (`events` for connection cells is the number of distinct sessions) and, by its schema note, in `run_query`. `tool_discovery` is unaffected: ingest writes it to `tool_registry`, a `ReplacingMergeTree(updated_at)` read with `FINAL`, so N reports are one row (`registered_at` is the latest report). Not shared across processes: `identify()`, traits and the step sequence (per-process LRU; the read side stitches users by the session's first `identify` event and ChatGPT users also by `subject_id`, and funnels order a session's steps by time, #145).

**Per-request sessions (added 2026-10-23, 0.5.4, #144).** A call with no key on an HTTP request is a `per_request` session: over HTTP a session of its own per call (on a per-request host the connection's session lived for one request anyway; since 0.5.5 on every host, #169), so 50 calls are 50 sessions of one call. Its `connection` event is emitted **once per process per client** — the `emittedConnections` mark is `per_request\0platform\0client_name\0client_version\0protocol_version\0intent_enabled` under the API key, with the client identity computed before the check — instead of once per (one-call) session; keyed and `connection` sessions keep one mark per session. The read side does not count a `per_request` session as a session (the Sessions KPI and users `totalSessions` exclude it, with a hint; the statistics job counts such an event as an individual only through its user key and leaves its connection rows out of the cells — see [storage-layer.md](../infrastructure/storage-layer.md)). Measured on 0.5.3 vs 0.5.4 (50 key-less calls, MCP SDK v1 stateless, v2 `createMcpHandler` in both eras, v1 with `req.auth`): connection events 50 → 1; with `sessionKey` from a header, VS Code's or the Codex CLI's key: sessions 50 → 1.

**No key, one call (0.5.5, #169).** Until 0.5.4 a long-lived server on one stateless transport (MCP SDK v1 1.24/1.25 allow reusing it; 1.26.0 refuses a second request, the fix for GHSA-345p-7cg4-v4c7 / CVE-2026-25536) landed every key-less caller on the connection's one session (labelled `per_request` on 0.5.4): `connect()` ran once per process, so the first identified user (a later caller's identify() was refused with 1302), its traits, its platform and the step sequence landed on every caller. `callSessions.resolve()` now creates a state per key-less HTTP call — `"ses_" + nanoid(21)`, no user, no traits, step sequence 0, the connection's platform (`unknown` on HTTP, so each call detects its own), `session_source` `per_request` — and does not store it in the map (50 such calls leave it empty); the proxy keeps only the last call's state for `tool_discovery` and a per-proxy `WeakSet` of these states. A key-less call made from inside such a call — a wrapped handler invoked directly, with the outer call's own context, one it built itself or none (the request store holds one of this proxy's per-call states; the set is per proxy, so a call into another wrapped server is never joined) — joins it and keeps the outer call's user and step sequence, as 0.5.4 did on a per-request host. It emits no `connection` event of its own: a call on its enclosing call's state (`openCallContext()`'s `nested`) leaves that to the outer call, whose context names the client and the protocol version. When the nested call's context had no request headers, 0.5.4 relabelled the shared session `connection` from the nested call on (the `identify` before it and the first `connection` event stayed `per_request`) and emitted a second `connection` event for it; 0.5.5 keeps `per_request` throughout and emits one. A key-less nested call inside a keyed call is not joined, as on 0.5.4: with request headers it gets a state of its own, without them the connection's. Measured on v1 1.24.0 and 1.25.3, four clients one after another on one reused transport, three of them identifying: 0.5.4 put all four calls on one `session_id` with the first caller's `user_id` and platform, steps 1–8 and two 1302 warnings, and three of the four `connection` events (one per client) carried the first caller's platform; 0.5.5 gives four sessions, each call its own user (or none), platform and steps 1, 2, three `identify` events and no 1302, with the same four `connection` events. Keyed calls on that transport keep their conversation. Per-request hosts (v1 1.32.1, v1 1.24/1.25 with a transport per request, v2 `createMcpHandler` in both eras) and stdio emit the same events as on 0.5.4. Not covered: a custom transport that multiplexes several clients and passes no request headers is indistinguishable from stdio, so its key-less callers still share the connection's state (`connection`); `sessionKey` can key it from `meta`.

One limit of this. **Eviction resets the conversation:** once a conversation falls out of the 1,000-entry map (1,000 other conversations touched the proxy in between), its next call starts a fresh state under the same `session_id` — `user_id` is gone until identify() runs again, the step sequence restarts at 1, and the one-user-per-session guard is reset. A second `connection` event for the same `session_id` marks the restart: the connection-event dedup (module-level, so a server that builds a new proxy per request still emits one per conversation) is a 10,000-entry least-recently-used map — a hit refreshes the entry, so an active conversation is never aged out by newer ones — that also drops an id when its proxy evicts the session (#120). The map is shared by every proxy in the process: two long-lived instrumented servers in one process that see the same conversation key share one mark. Tool discovery events stamp the session of the most recent tool call, or the connection's session before any call.

### 3.7.3 Widget Sessions

Widget events share the **server session ID** (`ses_` prefix). The server's `session_id` is included in `window.__YAVIO__` alongside the `traceId` and widget JWT (see [Section 3.4.2](#342-injection)), and the widget SDK stamps all outgoing events with it. This means all events — server-side and widget-side — for a single conversation share the same `session_id`, and the `trace_id` handles the finer-grained binding of a specific tool call to the widget it spawned.

There is no separate widget session ID. The `trace_id` is sufficient to correlate a widget interaction with its originating tool call, while the shared `session_id` ensures session-level aggregations (duration, tool count, conversions, retention) naturally include both server and widget activity without needing cross-session joins.

### 3.7.4 Hierarchy

```
Session (ses_xxx) ← one conversation (3.7.1), shared by server + widget events
  ├── Trace 1 (tr_aaa) ← tool_call "search_rooms"
  │   ├── step: "rooms_found"              (source: server)
  │   ├── widget_render                    (source: widget, same ses_xxx)
  │   ├── step: "room_selected"            (source: widget, same ses_xxx)
  │   └── conversion: "booking_completed"  (source: widget, same ses_xxx)
  ├── Trace 2 (tr_bbb) ← tool_call "check_availability"
  │   └── step: "availability_checked"
  └── Trace 3 (tr_ccc) ← tool_call "cancel_booking"
```

## Related specs (proposed 2026-08-26)

- [Tool-result errors count as errors](./tool-result-errors.md) — `isError: true` results become `status: error` / `error_category: tool_error`.
- [Per-tool capture overrides](./per-tool-capture.md) — `tools: { "<name>": { inputValues, outputValues, rejectedInputValues, intent } }`, plus a warn-once for tracking calls outside a wrapped tool.
- [`input_values` extra fields](./input-values-extra-fields.md) — what the `_`-prefixed fields are, which stay, which go.
- [Status detection at the protocol layer](./protocol-layer-status.md) — calls the MCP SDK fails before the handler (unknown/disabled tool, argument validation) become `status: error` / `validation`; output-validation failures become `server`; one event per call, also for a tool that asks for input over several rounds (#168, 0.5.5).
