# 4. React Widget SDK

## 4.1 Overview

The React entry point (`@yavio/sdk/react`) provides a hook-based API for tracking user interactions inside ChatGPT App widgets. It shares the same method names as the server-side API (including `.identify()`) but sends events directly to the Yavio ingestion API over HTTP.

> **Same API, Different Transport**
> Server-side: `ctx.yavio.step()` buffers events and flushes to the ingestion API in batches. Widget-side: `useYavio().step()` does the same — buffers events in memory and sends them via HTTP POST directly to the ingestion API. Configuration (API key, endpoint, traceId) is auto-injected by the server via `window.__YAVIO__`. The developer calls `useYavio()` with no arguments.

## 4.2 Developer-Facing API

The widget SDK requires zero configuration. The developer imports `useYavio()` and calls it with no arguments. The hook auto-detects the API key and endpoint injected by the server-side `withYavio()` proxy. The hook exposes the same explicit API as the server SDK: `.identify()`, `.step()`, `.track()`, and `.conversion()`.

```tsx
import { useEffect } from "react";
import { useYavio } from "@yavio/sdk/react";

function BookingWidget({ userId }: { userId: string }) {
  const yavio = useYavio(); // zero config — auto-detects API key & endpoint

  // Identify the user — ties all widget events to this user
  useEffect(() => {
    yavio.identify(userId, { source: "widget" });
  }, [userId]);

  const handleSelect = (room) => {
    yavio.step("room_selected", { roomType: room.type });
  };

  const handleBooking = async (booking) => {
    yavio.conversion("booking_completed", {
      value: booking.price,
      currency: "EUR",
    });
  };

  return <div>...</div>;
}
```

## 4.3 Auto-Configuration Injection

The server-side `withYavio()` proxy automatically injects widget configuration into every tool result via `_meta.yavio`. The developer never handles API keys, tokens, or endpoints.

### 4.3.1 Server-Side Injection

After each tool handler returns, the proxy mints a short-lived widget JWT via `POST /v1/widget-tokens` (see [Section 3.4.1](server-sdk.md#341-widget-token-minting)) and injects a `yavio` config object into the result's `_meta` field:

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

The project API key never reaches the widget. The JWT is trace-scoped and short-lived (see [Security Model](#45-security-model)). The `sessionId` ensures widget events share the same session as the server-side events that spawned them. The token is cached and reused across tool calls (see [Section 3.4.1](server-sdk.md#341-widget-token-minting)).

For widget-serving setups where the server controls the HTML bundle, the `window.__YAVIO__` global is also supported (see [Section 3.4.3](server-sdk.md#343-legacy-windowyavio-injection)).

### 4.3.2 Client-Side Detection

`useYavio()` resolves configuration in this order:

1. **`window.__YAVIO__`:** Global object injected by `withYavio()` at serve time. This is the primary path for widget-serving setups. The hook reads `token`, `endpoint`, `traceId`, and `sessionId`. Deleted after reading to reduce XSS exposure.
2. **Meta tag:** `<meta name="yavio-config" content="...">` — alternative injection point for non-standard widget serving setups. The content attribute is a JSON string with the same `{ token, endpoint, traceId, sessionId }` shape.
3. **Tool result metadata:** `input._meta.yavio` or `input.yavio` — extracted from the tool result passed to `useYavio()`. Handles both raw MCP results (`_meta.yavio`) and platform-transformed results (`.yavio`, e.g., Skybridge responseMetadata).
4. **Explicit config:** `useYavio({ token, endpoint, traceId, sessionId })` — manual override for edge cases. Not documented as the primary API.
5. **`null`:** No config found → no-op mode.

If no configuration is found, `useYavio()` returns a no-op instance that silently discards all events. This prevents widget crashes in development or testing environments where `withYavio()` is not running.

#### `extractWidgetConfig()` Helper

For consumers who handle tool results outside the hook, `@yavio/sdk/react` exports a standalone `extractWidgetConfig(input)` function. It checks for config at `.yavio` or `._meta.yavio` and returns a validated `WidgetConfig` or `null`. This is the same logic used internally by `resolveWidgetConfig()`.

```tsx
import { extractWidgetConfig, useYavio } from "@yavio/sdk/react";

// Extract config from a tool result
const config = extractWidgetConfig(toolResult);
const yavio = useYavio(config ?? undefined);
```

### 4.3.3 Noop-to-Active Upgrade

`useYavio()` supports lazy configuration: if the hook is first called with no config (returning a no-op widget), it can be upgraded to an active widget on a subsequent render when valid config arrives (e.g., when a tool result containing `_meta.yavio` becomes available). The hook re-attempts config resolution when the `config` argument transitions from absent to present, tears down the no-op instance, and creates a real transport-backed widget.

## 4.4 Hook Internals

- **Singleton pattern:** First `useYavio()` call initializes a module-level singleton (event buffer, flush timer, teardown listeners). Subsequent calls in child components return the same instance. The widget uses the server's `session_id` (read from `window.__YAVIO__.sessionId`) for all outgoing events, so server and widget events share the same session. The `trace_id` handles finer-grained correlation between a specific tool call and its widget. See [server-sdk.md Section 3.7](server-sdk.md#37-session-lifecycle) for the full session model.
- **Event buffer:** Events are collected in memory and flushed every 5 seconds or when the buffer reaches 20 events, whichever comes first.
- **Flush on teardown:** Uses `navigator.sendBeacon()` on `visibilitychange` and page unload to ensure events are delivered even when the widget is closing.
- **Retry logic:** Failed HTTP requests are retried up to 3 times with exponential backoff (1s, 2s, 4s). A `401 Unauthorized` response (expired or invalid JWT) stops retrying immediately.
- **Offline tolerance:** If the ingestion API is unreachable, events accumulate in the buffer (up to 200 max). Oldest events are dropped if the buffer overflows.
- **Authentication:** Every HTTP request includes `Authorization: Bearer <widgetJwt>` header. The JWT is a short-lived token (15 min) minted by the server-side proxy — the project API key never reaches the widget.

### 4.4.1 Request Format

The widget SDK uses the same ingestion endpoint and request format as the server SDK:

```http
POST /v1/events HTTP/1.1
Host: ingest.yavio.ai
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...
Content-Type: application/json

{
  "events": [
    {
      "event_type": "step",
      "event_name": "room_selected",
      "timestamp": "2026-03-15T10:31:05.456Z",
      "trace_id": "tr_8f2a...",
      "session_id": "ses_abc...",
      "source": "widget",
      "viewport_width": 400,
      "viewport_height": 600,
      "metadata": { "roomType": "suite" }
    }
  ],
  "sdk_version": "1.0.0",
  "sent_at": "2026-03-15T10:31:10.000Z"
}
```

> **Note:** The `Authorization` header carries a short-lived widget JWT (not the project API key). The ingestion API verifies the JWT signature, checks expiry, and extracts `project_id` and `trace_id` from the token claims. The `trace_id` in the event payload must match the `tid` claim in the JWT.

### 4.4.2 CORS Requirements

The ingestion API must accept cross-origin requests from widget iframes. CORS headers:

| Header | Value | Rationale |
|--------|-------|-----------|
| `Access-Control-Allow-Origin` | Allowlist of known AI platform origins (see below) | Restricts cross-origin access to known widget hosts |
| `Access-Control-Allow-Methods` | `POST, OPTIONS` | Write-only endpoint |
| `Access-Control-Allow-Headers` | `Authorization, Content-Type` | JWT auth + JSON body |
| `Access-Control-Max-Age` | `86400` | Cache preflight for 24 hours |

**Default allowed origins:**

| Origin | Platform |
|--------|----------|
| `https://chatgpt.com` | ChatGPT |
| `https://chat.openai.com` | ChatGPT (legacy) |
| `https://claude.ai` | Claude |
| `https://cursor.sh` | Cursor |

Additional origins can be configured per project via the dashboard settings or the `YAVIO_CORS_ORIGINS` environment variable (comma-separated list). This allows developers to add custom domains for self-hosted or development environments while keeping the default restrictive.

## 4.5 Security Model

The widget never receives the project API key. Instead, it authenticates with a short-lived JWT that is:

- **Trace-scoped:** The JWT contains a `tid` (trace ID) claim. The ingestion API rejects events whose payload `traceId` does not match the JWT's `tid`. An extracted token cannot be used to inject events into other traces.
- **Short-lived:** 15-minute expiry. Even if extracted from the browser, the token becomes useless quickly. Sufficient for typical widget interaction sessions.
- **Write-only:** The JWT grants permission to push events to `POST /v1/events` only. It cannot read analytics data, access the dashboard, or call any other endpoint.
- **Rate-limited:** Events from widget JWTs are rate-limited per token (50 events per session) in addition to the per-API-key rate limits.

If the JWT expires during a long-running widget session, subsequent event flushes will receive `401 Unauthorized` and stop retrying. Event loss in this edge case is acceptable for V1; token refresh may be added in a future version.

### 4.5.1 Known Limitation: `window.__YAVIO__` Global Exposure

The widget JWT and trace ID are injected as a global `window.__YAVIO__` object, which is readable by any script running in the same iframe context. If the widget contains a cross-site scripting (XSS) vulnerability, an attacker could exfiltrate the JWT.

**Mitigations already in place:**
- The JWT is trace-scoped — it can only submit events for the specific `traceId` it was minted for
- The JWT is short-lived (15-minute expiry) — an exfiltrated token becomes useless quickly
- The JWT is write-only — it cannot read analytics data, access the dashboard, or call any other endpoint
- The ingestion API validates that every event's `traceId` matches the JWT's `tid` claim (batch-level trace validation)

**Additional defense (recommended):** After `useYavio()` reads the config on first initialization, it deletes `window.__YAVIO__` to reduce the exposure window. However, this does not protect against scripts that execute before the hook initializes.

**Developer responsibility:** Widget developers should follow standard XSS prevention practices (sanitize user input, avoid `dangerouslySetInnerHTML`, use Content-Security-Policy). The Yavio SDK does not introduce the XSS vector — it only means that an existing XSS vulnerability could lead to short-lived analytics token theft in addition to the usual XSS consequences.

## 4.6 Auto-Captured Widget Events


For the complete list of widget auto-captured events and their fields, see [metrics/events.md](metrics/events.md#widget-auto-captured).

For derived metrics computed from these events (TTFI, cost estimation, etc.), see [metrics/metrics.md](metrics/metrics.md).
