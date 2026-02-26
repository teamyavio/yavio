# Captured Events

All events stored as rows in the `events` table. Each event carries `event_id` (UUID, dedup key), `trace_id`, `session_id`, `timestamp`, `platform`, and `source` (server | widget).

**Session ID semantics:** A `session_id` represents a single MCP connection, derived from the MCP `initialize` handshake (`ses_` prefix). Both server and widget events share the same `session_id` — the server propagates it to the widget via `window.__YAVIO__.sessionId`. Multiple traces (tool invocations) can share the same `session_id`. The `trace_id` provides finer-grained correlation between a specific tool call and its widget. See [server-sdk.md Section 3.7](../sdk/server-sdk.md#37-session-lifecycle) for derivation rules.

---

## Server-Side Auto-Captured

### tool_call

Fires on every tool invocation. The core event.

| Field | Type | Description |
|-------|------|-------------|
| event_name | TEXT | Tool name |
| latency_ms | REAL | Execution time |
| status | TEXT | `success` or `error` |
| error_category | TEXT | `auth` / `validation` / `timeout` / `rate_limit` / `server` / `unknown` |
| error_message | TEXT | Sanitized, PII-stripped |
| is_retry | INTEGER | `1` if the immediately preceding event in the session was a `tool_call` with the same `event_name` |
| input_keys | TEXT (JSON) | Parameter key names |
| input_types | TEXT (JSON) | Key-to-type mapping |
| intent_signals | TEXT (JSON) | Derived intent hints (e.g., `"intent:budget"`) |
| tokens_in | INTEGER | Estimated prompt tokens |
| tokens_out | INTEGER | Estimated completion tokens |
| country_code | TEXT | ISO 3166-1 alpha-2 from CDN headers |

### connection

Fires on transport connect and disconnect.

| Field | Type | Description |
|-------|------|-------------|
| protocol_version | TEXT | MCP protocol version |
| client_name | TEXT | `clientInfo.name` from initialize |
| client_version | TEXT | `clientInfo.version` from initialize |
| connection_duration_ms | REAL | Connection lifetime (on disconnect) |

### resource_access

Fires on `resources/read` and `resources/list` interception.

| Field | Type | Description |
|-------|------|-------------|
| event_name | TEXT | Resource name |
| metadata | TEXT (JSON) | URI, access count, response size |

### prompt_usage

Fires on `prompts/list` and `prompts/get` interception.

| Field | Type | Description |
|-------|------|-------------|
| event_name | TEXT | Prompt name |
| metadata | TEXT (JSON) | Argument values (PII-stripped), usage frequency |

### sampling_call

Fires on `sampling/createMessage` interception (server-to-client).

| Field | Type | Description |
|-------|------|-------------|
| latency_ms | REAL | Round-trip latency |
| tokens_in | INTEGER | Input token count |
| tokens_out | INTEGER | Output token count |
| metadata | TEXT (JSON) | Model hint |

### elicitation

Fires on `elicitation/requestInput` interception (server-to-client).

| Field | Type | Description |
|-------|------|-------------|
| latency_ms | REAL | Response latency |
| metadata | TEXT (JSON) | Field schema, accepted vs. declined |

### widget_response

Fires when the server-side proxy detects a widget response (via `_meta.ui.resourceUri`) in a tool call return value. This is the server-side counterpart to the widget-side `widget_render` event.

| Field | Type | Description |
|-------|------|-------------|
| event_name | TEXT | Tool name that returned the widget |
| metadata | TEXT (JSON) | resourceUri, widget token minted (boolean), traceId passed to widget |

### tool_discovery

Fires on `tools/list` request interception. Tracks how often and when clients request the tool catalog. See [server-sdk.md §3.1.3](../sdk/server-sdk.md).

| Field | Type | Description |
|-------|------|-------------|
| metadata | TEXT (JSON) | `tools_listed` (array of tool names returned), `tools_count` (integer), `client_name`, `client_version`, `client_capabilities` (object: supported MCP features) |

---

## Server-Side Explicit

### step

Funnel progression point. Called via `yavio.step()`.

| Field | Type | Description |
|-------|------|-------------|
| event_name | TEXT | Step name |
| step_sequence | INTEGER | Auto-incrementing counter per trace (0, 1, 2, ...). Enables deterministic ordering when multiple steps share the same millisecond timestamp. |
| metadata | TEXT (JSON) | Custom properties (PII-stripped) |

### track

Generic custom event. Called via `yavio.track()`.

| Field | Type | Description |
|-------|------|-------------|
| event_name | TEXT | Event name |
| metadata | TEXT (JSON) | Custom properties (PII-stripped) |

### conversion

Revenue attribution event. Called via `yavio.conversion()`.

| Field | Type | Description |
|-------|------|-------------|
| event_name | TEXT | Conversion name |
| conversion_value | REAL | Monetary value |
| conversion_currency | TEXT | ISO currency code |
| metadata | TEXT (JSON) | Custom properties (PII-stripped) |

### identify

User identification event. Called via `yavio.identify()`.

| Field | Type | Description |
|-------|------|-------------|
| user_id | TEXT | Developer-provided user identifier (not PII-stripped) |
| user_traits | TEXT (JSON) | User properties (PII-stripped) |
| metadata | TEXT (JSON) | Additional context |

---


## Widget Auto-Captured

### widget_render

Fires once on `useYavio()` first initialization.

| Field | Type | Description |
|-------|------|-------------|
| viewport_width | INTEGER | Widget viewport width |
| viewport_height | INTEGER | Widget viewport height |
| device_pixel_ratio | REAL | Device pixel ratio |
| device_touch | INTEGER | Touch capable (0/1) |
| connection_type | TEXT | Network type (4g, wifi, etc.) |
| metadata | TEXT (JSON) | Preferred language, timezone offset |

### widget_error

Fires on unhandled JS error or promise rejection.

| Field | Type | Description |
|-------|------|-------------|
| metadata | TEXT (JSON) | Sanitized error message, truncated stack trace |

### widget_visibility

Fires when widget enters or exits viewport (IntersectionObserver).

| Field | Type | Description |
|-------|------|-------------|
| visible_duration_ms | REAL | Visible duration |
| metadata | TEXT (JSON) | Percentage in view |

### widget_click

Fires on every click/tap event.

| Field | Type | Description |
|-------|------|-------------|
| event_name | TEXT | Target element identifier (`data-yavio` attribute or tag name) |
| click_count | INTEGER | Running click count |
| metadata | TEXT (JSON) | Element type (button, link, input), coordinates |

### widget_scroll

Fires on scroll events within widget container.

| Field | Type | Description |
|-------|------|-------------|
| event_name | TEXT | Scrollable container identifier |
| scroll_depth_pct | REAL | Max scroll depth (0-100) |
| metadata | TEXT (JSON) | Scroll direction, velocity |

### widget_form_field

Fires on focus and blur of form inputs.

| Field | Type | Description |
|-------|------|-------------|
| event_name | TEXT | Form identifier |
| field_name | TEXT | Field name (not value) |
| metadata | TEXT (JSON) | Time spent in field, filled vs. abandoned |

### widget_form_submit

Fires on form submission attempt.

| Field | Type | Description |
|-------|------|-------------|
| event_name | TEXT | Form identifier |
| status | TEXT | `success` or `error` |
| metadata | TEXT (JSON) | Validation errors (field names only), time from first focus to submit |

### widget_link_click

Fires on click of anchor or external link.

| Field | Type | Description |
|-------|------|-------------|
| event_name | TEXT | Link identifier (`data-yavio` attribute or link text) |
| metadata | TEXT (JSON) | Link destination domain (not full URL), link text |

### widget_navigation

Fires on view/route change within multi-step widget.

| Field | Type | Description |
|-------|------|-------------|
| nav_from | TEXT | Previous view |
| nav_to | TEXT | Current view |
| metadata | TEXT (JSON) | Time on previous view |

### widget_focus

Fires when widget iframe gains or loses focus.

| Field | Type | Description |
|-------|------|-------------|
| metadata | TEXT (JSON) | Focus duration, focus count |

### widget_performance

Fires via PerformanceObserver on widget load.

| Field | Type | Description |
|-------|------|-------------|
| load_time_ms | REAL | Time to interactive |
| metadata | TEXT (JSON) | Time to first paint, DOM content loaded, resource transfer size |

### widget_rage_click

Fires when 3+ clicks occur within 500ms on the same element.

| Field | Type | Description |
|-------|------|-------------|
| event_name | TEXT | Target element identifier (`data-yavio` attribute or tag name) |
| metadata | TEXT (JSON) | Click count, timing |



## Widget Explicit

These are the same event types as the server-side explicit events (`step`, `track`, `conversion`), emitted from the widget via `useYavio()`. They share the same schema but are sent with `source: "widget"` over HTTP POST to the ingestion API instead of being buffered through the MCP proxy.

### step

Funnel progression point. Called via `useYavio().step()`.

| Field | Type | Description |
|-------|------|-------------|
| event_name | TEXT | Step name |
| step_sequence | INTEGER | Auto-incrementing counter per trace (continues from server-side sequence via traceId). Enables deterministic ordering across server and widget steps. |
| metadata | TEXT (JSON) | Custom properties (PII-stripped) |

### track

Generic custom event. Called via `useYavio().track()`.

| Field | Type | Description |
|-------|------|-------------|
| event_name | TEXT | Event name |
| metadata | TEXT (JSON) | Custom properties (PII-stripped) |

### conversion

Revenue attribution event. Called via `useYavio().conversion()`.

| Field | Type | Description |
|-------|------|-------------|
| event_name | TEXT | Conversion name |
| conversion_value | REAL | Monetary value |
| conversion_currency | TEXT | ISO currency code |
| metadata | TEXT (JSON) | Custom properties (PII-stripped) |

### identify

User identification event. Called via `useYavio().identify()`.

| Field | Type | Description |
|-------|------|-------------|
| user_id | TEXT | Developer-provided user identifier (not PII-stripped) |
| user_traits | TEXT (JSON) | User properties (PII-stripped) |
| metadata | TEXT (JSON) | Additional context |

---