# Captured Events

All events stored as rows in the `events` table. Each event carries `event_id` (UUID, dedup key), `trace_id`, `session_id`, `timestamp`, `platform`, and `source` (server | widget). Server events from SDK 0.5.4 on also carry `session_source`.

**Session ID semantics:** A `session_id` represents one conversation (`ses_` prefix), derived per tool call from the first conversation key the call carries — `Mcp-Session-Id`, `_meta["openai/session"]`, `_meta["vscode.conversationId"]`, the Codex CLI's `_meta.threadId`, the integrator's `sessionKey` — else the connection's own session. `session_source` (LowCardinality Nullable String, migration 0022, #144) records which: `mcp_session_id` | `openai_session` | `vscode_conversation` | `codex_thread` | `custom` | `connection` (no key, non-HTTP) | `per_request` (no key on an HTTP request: on a per-request host one call, which the read side does not count as a session); The React SDK stamps its server session's source on widget events too (from `_meta.yavio.sessionSource`); NULL is an SDK before 0.5.4, server or widget. The schema takes a string of at most 32 characters, not an enum, and ingest NULLs a value it does not know. Both server and widget events share the same `session_id` — the server propagates it to the widget via `window.__YAVIO__.sessionId`. Multiple traces (tool invocations) can share the same `session_id`. The `trace_id` provides finer-grained correlation between a specific tool call and its widget. See [server-sdk.md Section 3.7](../sdk/server-sdk.md#37-session-lifecycle) for derivation rules.

---

## Server-Side Auto-Captured

### tool_call

Fires on every tool invocation. The core event. One per logical call also when the tool asks for input over several rounds (MCP SDK v2 `inputRequired()`, SDK 0.5.5+, #168): the event comes from the round whose result is final; rounds that asked for input send none.

| Field | Type | Description |
|-------|------|-------------|
| event_name | TEXT | Tool name |
| latency_ms | REAL | Handler execution time. **Absent** when the handler never ran (pre-handler failures, see `validation`). For a call that asked for input: the handler time of the rounds inside the request, never the user's think time — every round on v2's 2025-era shim, the final request only on MCP 2026-07-28 (its earlier rounds were other requests) |
| metadata | TEXT (JSON) | Unset on an ordinary call. Multi-round-trip markers (SDK 0.5.5+, #168): `input_rounds` — how many times the handler returned `input_required` inside this request before the result that went out (exact on the 2025 shim; `1` when v2 refused a 2026-07-28 round's input request); `input_retry: true` — the request is the client's 2026-07-28 retry. A call asked for input when `input_rounds > 0 OR input_retry`. A 2026-07-28 call whose client never retries leaves no `tool_call`. Not columns: no migration until the dashboard filters on them |
| status | TEXT | `success` or `error`. `error` when the handler threw, returned a result with `isError: true`, or the MCP SDK rejected the call before or after the handler (SDK ≥ 0.4.0; earlier SDKs only report throws) |
| error_category | TEXT | `tool_error` (handler returned `isError: true`) / `unknown` (handler threw) / `validation` (failed before the handler: unknown or disabled tool, argument validation) / `server` (result failed the tool's `outputSchema`; or the handler asked for input and the MCP SDK could not get it or refused it, #168) / reserved: `auth`, `timeout`, `rate_limit`. See [sdk/tool-result-errors.md](../sdk/tool-result-errors.md) and [sdk/protocol-layer-status.md](../sdk/protocol-layer-status.md) |
| error_message | TEXT | The exception message, or the first `text` content item of an `isError` result. PII-stripped, ≤ 500 chars. The result text is output and is only stored with `capture.outputValues` on |
| is_retry | INTEGER | Intended: `1` if the immediately preceding event in the session was a `tool_call` with the same `event_name`. **Not implemented** — the SDK never sets it and ingest does not derive it, so the column is always `0` |
| input_keys | TEXT (JSON) | Parameter key names |
| input_types | TEXT (JSON) | Key-to-type mapping |
| input_values | TEXT (JSON) | Tool arguments plus, under `_`-prefixed keys, `_meta` (the request `_meta` verbatim; `openai/userLocation` reduced to `{ country, region }` with `capture.geo: "region"` and `{ country }` with `"country"`, removed when it is off; in all three only `openai/locale`, `openai/userAgent`, `openai/subject` and `openai/session` stay besides the location (`KNOWN_META_KEYS` in `proxy.ts`); `_metaDroppedKeys` lists the names of the dropped keys, `_metaDroppedUnnamed` counts those it does not name), `_taskId` and `_requestInfo` (five allow-listed headers + URL sans query). PII-stripped. See [sdk/input-values-extra-fields.md](../sdk/input-values-extra-fields.md) |
| output_content | TEXT (JSON) | The CallToolResult (content with binary placeholders, structuredContent, isError, _meta before widget injection). PII-stripped |
| intent_signals | TEXT (JSON) | `{ intent, source }` — the model's stated intent (see sdk/intent capture) |
| intent_context | TEXT | How the SDK advertised the intent `context` parameter for the tool at call time (#73): `required`; `optional` (widget-invoked tool — the widget's own calls cannot send it — or intent `required: false`); `none` (nothing advertised: intent capture off, per-tool `intent: false`, own `context` or a schema the SDK cannot extend, unknown tool). NULL: SDK < 0.4.0 (or, rarely, intent on but the protocol layer could not be wrapped). One rule (`advertisement()` in `server/intent.ts`) serves tools/list and the stamp. It is the server's current advertisement; a host showing a cached schema can differ until it refreshes. Deliberately not "model vs widget": on a widget-invoked tool a model call that skips the optional parameter is indistinguishable from the widget's own call, and models skip it often (an integration, 2026-10: 57% of conversations' first calls had no intent). Dashboard Call Coverage = intents / calls with `required` or NULL; optional-context calls get their own share; `none` is in neither. A date range spanning a project's upgrade still holds NULL rows counted the old way. Migration `0019` |
| tokens_in | INTEGER | Reserved — not set by the SDK today |
| tokens_out | INTEGER | Reserved — not set by the SDK today |
| country_code | TEXT | ISO 3166-1 alpha-2 from the platform's request `_meta` (`openai/userLocation.country`); omitted with `capture.geo: false` |
| region | TEXT | State or province from `openai/userLocation.region`, as the platform names it (ChatGPT: English, e.g. "North Rhine-Westphalia", "State of Berlin"; not ISO 3166-2). Sent by SDK 0.4.1+ with `capture.geo` `true` or `"region"` and, like all client metadata, only with `capture.inputValues` on (#127). One rule, `normalizeRegionName()` in `@yavio/shared/geo`, applied by the SDK and again by ingest: NFC, apostrophe look-alikes (U+2018/2019, U+02BC, U+00B4, U+0060, U+2032) and dashes folded to `'` and `-`, spaces collapsed, at most 64 characters of letters, marks, spaces and `-'.,()/&·`, at least one letter. Ingest keeps it only next to a valid `country_code`; anything else becomes NULL and counts as an invalid field, the event is kept (#128). Raw events only, not in `stats_daily`. Migration `0020` |
| locale / end_user_agent / subject_id | TEXT | Client metadata from the request `_meta` (`openai/locale`, `openai/userAgent`, `openai/subject`); captured only with `capture.inputValues` on. Intentionally duplicated inside `input_values._meta` |

### connection

Deferred to a session's first tool call: at least once per session per server process (#142); for a `per_request` session once per process per client — platform, client name and version, protocol version, `intent_enabled` — instead of once per call (#144). No disconnect variant is sent.

| Field | Type | Description |
|-------|------|-------------|
| protocol_version | TEXT | MCP protocol version (the `mcp-protocol-version` header, date-shaped only) |
| client_name | TEXT | The client's name: the 2026-07-28 envelope, else `clientInfo.name` from initialize, else the request's User-Agent (known MCP clients only) |
| client_version | TEXT | The same source's version |
| connection_duration_ms | REAL | Reserved: connection lifetime (never set) |

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

Fires on `tools/list` request interception — once per tool name per process, for tools registered through the proxy. Feeds `tool_registry` (ReplacingMergeTree on `updated_at`, so a newer discovery replaces an older row). See [server-sdk.md §3.1.3](../sdk/server-sdk.md).

| Field | Type | Description |
|-------|------|-------------|
| tool_name | TEXT | Tool name |
| description | TEXT | Tool description as listed, clamped to 2048 characters (ingest's limit) |
| input_schema | JSON | The tool's input JSON Schema as listed to the client (converted by the MCP SDK), without the intent `context` parameter; omitted above 16,384 characters |

Not implemented (an earlier version of this spec described it): per-listing counts, `tools_listed`, client capabilities.

---

## Server-Side Explicit

### step

Funnel progression point. Called via `yavio.step()`.

| Field | Type | Description |
|-------|------|-------------|
| event_name | TEXT | Step name |
| step_sequence | INTEGER | Counter per session per SDK process (1, 2, 3, ...): it starts at 1 again on every instance of a stateless fleet and after an LRU eviction. Funnels order a session's steps by timestamp and use it only to break a tie within one millisecond (#145). |
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

Read side (#145): the SDK stamps `user_id` only on the later events of the process that called `identify()`. The dashboard and the statistics job count every event of the session for the user of its **first** `identify` event (an event's own `user_id` wins), so the session's other instances and its events before the call count too. The `identify` rows are the only source of that mapping, and of traits.

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
| step_sequence | INTEGER | Counter per widget load (1, 2, 3, ...); it does not continue from the server's sequence. Funnels place widget steps among the session's server steps by timestamp (the browser's clock) and use it only to break a tie within one millisecond (#145). |
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