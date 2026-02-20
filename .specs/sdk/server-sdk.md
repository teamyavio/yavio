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
    inputValues: true,  // full input values (PII-stripped server-side)
    geo: true,         // geographic distribution
    tokens: true,      // token estimation
    retries: true,     // retry detection
  },
});
```

### 3.1.2 Config Discovery

`withYavio()` resolves configuration in priority order:

1. **Code options:** Values passed directly to `withYavio(server, { apiKey, endpoint })`. Highest priority.
2. **Environment variables:** `YAVIO_API_KEY` and `YAVIO_ENDPOINT`. Used when code options are not provided.
3. **`.yaviorc.json`:** Reads `apiKey` and `endpoint` from the nearest `.yaviorc.json` file (walks up from `process.cwd()`). Lowest priority. Created by `yavio init`.

If no API key is found through any source, `withYavio()` logs a warning and returns a transparent pass-through proxy that does not capture any events. This prevents crashes in environments where analytics is not configured.

### 3.1.3 Proxy Internals

The proxy uses JavaScript `Proxy` to intercept method calls on the `McpServer` instance. The key interception points are:

- **`server.tool()` and `server.registerTool()` registration:** Intercepts both the deprecated `tool()` method and the modern `registerTool()` method (MCP SDK v1.26+) to capture tool names, descriptions, and schemas. Wraps the handler function with identical instrumentation via a shared `wrapToolCallback()` helper. For `tool()`, the callback is located by scanning for the first function argument (handles all overloads). For `registerTool()`, the callback is always the 3rd positional argument.
- **Tool handler execution:** Before/after hooks capture invocation timestamp, measure latency, catch errors, detect platform, and capture full input values and derive input patterns.
- **`server.connect()` / transport:** Intercepts transport connection to detect platform from headers, user-agent, or protocol-specific signals. Intercepts the MCP `initialize` request to derive the `session_id` (see [Section 3.7](#37-session-lifecycle)).
- **`tools/list` requests:** Intercepts tool discovery calls to track how often and when clients request the tool catalog. Records tool discovery events including which tools were listed and the client's initial capabilities.
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
}, async (params, ctx) => {
  // User identification: tie this session to a known user
  ctx.yavio.identify(params.userId, { plan: "premium", country: "DE" });

  const rooms = await searchRooms(params);

  // Funnel step: mark progress through a user journey
  ctx.yavio.step("rooms_found", { count: rooms.length });

  // Custom event: track anything not auto-captured
  ctx.yavio.track("cache_hit", { provider: "memory" });

  const booking = await confirmBooking(rooms[0]);

  // Conversion: revenue attribution
  ctx.yavio.conversion("booking_completed", {
    value: booking.price,
    currency: "EUR",
  });

  return booking;
});

// The deprecated tool() API is also supported
server.tool("book_room", async (params, ctx) => {
  ctx.yavio.identify(params.userId);
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

// Outside any request context: events are captured but lack
// request-specific fields (traceId, platform, toolName)
yavio.track("server_started", { version: "1.0.0" });
```

### 3.2.3 Method Signatures

| Method | Signature | Description |
|--------|-----------|-------------|
| `.identify()` | `identify(userId: string, traits?: Record<string, unknown>)` | Ties the current session and all subsequent events to a known user. Traits are persisted as user properties. Enables retention, cohort, and per-user analytics. |
| `.step()` | `step(name: string, meta?: Record<string, unknown>)` | Marks a funnel step. Each step receives an auto-incrementing `step_sequence` (per trace) for deterministic ordering. Powers the combined funnel visualization. |
| `.track()` | `track(event: string, properties?: Record<string, unknown>)` | Generic custom event. Escape hatch for anything not auto-captured or not a funnel step. |
| `.conversion()` | `conversion(name: string, data: { value: number; currency: string; meta?: Record<string, unknown> })` | Revenue attribution event. Value and currency are required. Powers ROI analytics. |

> **PII Stripping:** PII redaction uses a defense-in-depth strategy across two layers. The **SDK** runs a lightweight, non-configurable best-effort pass (`core/pii.ts`) that strips common PII patterns (emails, credit cards, SSNs, phone numbers) from event payloads before they leave the process. The **ingestion API** then runs a full configurable scrub as the authoritative safety net before writing to ClickHouse. Both layers are ON by default and not configurable in v1.

### 3.2.4 Identify Behavior

`.identify(userId, traits?)` associates the current session with a known user:

- **userId** is a developer-provided string (e.g., database ID, external ID). It is NOT stripped by PII — it is the developer's chosen identifier.
- **traits** are optional key-value pairs describing the user (e.g., `{ plan: "pro", company: "Acme" }`). Traits are PII-stripped like all other metadata.
- Calling `.identify()` emits an `identify` event and sets `user_id` on all subsequent events in the current session (server-side via AsyncLocalStorage, widget-side via the singleton).
- Multiple `.identify()` calls in the same session update the traits (merge, not replace). The `userId` cannot change within a session — a second call with a different `userId` logs a warning and is ignored.
- Events emitted before `.identify()` in a session will have `user_id = null`. The dashboard can stitch these retroactively using `session_id` → `user_id` mapping from the identify event.

## 3.3 HTTP Batch Transport

The SDK buffers events in memory and flushes them to the Yavio ingestion API in batches. This ensures zero impact on tool call latency.

### 3.3.1 Transport Behavior

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Flush interval | 10 seconds | Balances delivery latency with batch efficiency |
| Max batch size | 100 events | Triggers early flush if buffer fills before interval |
| Max buffer size | 10,000 events | Prevents memory exhaustion under extreme load. Oldest dropped with warning. |
| Retry strategy | Exponential backoff: 1s, 2s, 4s, 8s, 16s (max 5 retries) | Handles transient network/ingestion failures |
| Shutdown | Async final flush on `process.exit` / `SIGTERM` | Awaits all pending batches before resolving |
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
      "sessionId": "ses_abc..."
    }
  }
}
```

If the result already has a `_meta` object, the proxy preserves existing fields and adds `yavio` alongside them. If minting fails or the result is not an object, the result is returned unchanged.

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
5. Tool handler executes (`ctx.yavio.step()` calls inherit traceId)
6. If tool returns widget: proxy calls `POST /v1/widget-tokens` with traceId and sessionId to mint a short-lived JWT
7. Proxy injects `window.__YAVIO__` with traceId + sessionId + widget JWT + endpoint (API key stays on server)
8. Widget renders in iframe, initializes `useYavio()` which reads `window.__YAVIO__`
9. Widget events sent directly to ingestion API with JWT auth and traceId in payload
10. Ingestion API verifies JWT, stores all events — same traceId forms one funnel in ClickHouse

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

An **analytics session** represents a single MCP connection between a client (AI platform) and the instrumented server. The session boundary is defined by the MCP protocol's `initialize` handshake: **one `initialize` handshake = one session**.

### 3.7.1 Session Derivation from MCP

The proxy intercepts the MCP `initialize` request (which fires exactly once per transport connection) and uses it as the session boundary. The `session_id` is derived differently depending on the MCP transport:

| Transport | Session ID Source | Rationale |
|-----------|------------------|-----------|
| **Streamable HTTP** | Adopt the server-assigned `Mcp-Session-Id` header from the `InitializeResult` HTTP response: `"ses_" + Mcp-Session-Id`. If the server does not assign one (the header is optional per the MCP spec), fall back to generating one. | 1:1 mapping with the MCP protocol session. Reconnections via `Last-Event-ID` stay in the same session; a fresh `initialize` starts a new one. |
| **stdio** | Generate on `initialize` interception: `"ses_" + nanoid(21)`. | No protocol-level session ID exists for stdio. The `initialize` request fires once per subprocess lifetime, providing a natural boundary. |
| **Legacy SSE** | Generate on `initialize` interception: `"ses_" + nanoid(21)`. | Deprecated transport with no session ID mechanism. Same generation strategy as stdio. |

The generated or adopted `session_id` is stored in the `InstrumentationLayer` state. All subsequent events on that connection (tool calls, steps, conversions, resource accesses, etc.) inherit it automatically.

### 3.7.2 Session Boundary Rules

| Rule | Behavior |
|------|----------|
| New `initialize` handshake | Always starts a new session, regardless of transport. |
| Transport reconnection without re-initialization | Continues the existing session. This applies to Streamable HTTP resumability (`Last-Event-ID` + same `Mcp-Session-Id`), where no new `initialize` fires. |
| Transport disconnect | Ends the session. The `connection` event (disconnect variant) is the last event in the session. |
| Multiple traces per session | Expected. A single MCP connection typically serves multiple tool invocations, each with its own `trace_id`. All traces within one connection share the same `session_id`. |
| `userId` scope | Bound to the session. `.identify()` sets `user_id` for all subsequent events in the session. Cannot change within a session. |

### 3.7.3 Widget Sessions

Widget events share the **server session ID** (`ses_` prefix). The server's `session_id` is included in `window.__YAVIO__` alongside the `traceId` and widget JWT (see [Section 3.4.2](#342-injection)), and the widget SDK stamps all outgoing events with it. This means all events — server-side and widget-side — for a single MCP connection share the same `session_id`, and the `trace_id` handles the finer-grained binding of a specific tool call to the widget it spawned.

There is no separate widget session ID. The `trace_id` is sufficient to correlate a widget interaction with its originating tool call, while the shared `session_id` ensures session-level aggregations (duration, tool count, conversions, retention) naturally include both server and widget activity without needing cross-session joins.

### 3.7.4 Hierarchy

```
Session (ses_xxx) ← one MCP connection, shared by server + widget events
  ├── Trace 1 (tr_aaa) ← tool_call "search_rooms"
  │   ├── step: "rooms_found"              (source: server)
  │   ├── widget_render                    (source: widget, same ses_xxx)
  │   ├── step: "room_selected"            (source: widget, same ses_xxx)
  │   └── conversion: "booking_completed"  (source: widget, same ses_xxx)
  ├── Trace 2 (tr_bbb) ← tool_call "check_availability"
  │   └── step: "availability_checked"
  └── Trace 3 (tr_ccc) ← tool_call "cancel_booking"
```
