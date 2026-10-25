# Error Catalog

Comprehensive error code catalog for all Yavio platform services. Every error that surfaces to a user, appears in logs, or is captured by Sentry uses a code from this catalog. Error codes provide stable, searchable identifiers that tie API responses, structured logs, Prometheus metrics, and Sentry events together into a single observability story.

## Design Principles

1. **Every error has a code.** No unnamed errors in production. Unhandled exceptions are caught and assigned `YAVIO-x999` (the "catch-all" code for each service range).
2. **Codes are stable.** Once assigned, a code is never reused for a different error. Deprecated codes are marked as such, not reassigned.
3. **Codes appear everywhere.** HTTP responses (`error.code`), Pino log lines (`err.code`), Sentry tags (`yavio.error_code`), and Prometheus labels (`reason`).
4. **Codes are searchable.** Paste `YAVIO-2003` into Sentry, Loki, or Grafana and find every occurrence across all services.

## Error Response Format

All HTTP services return errors in this shape:

```json
{
  "error": {
    "code": "YAVIO-2003",
    "message": "API key has been revoked",
    "status": 401,
    "requestId": "req_a1b2c3"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `code` | string | Stable error code from this catalog |
| `message` | string | Human-readable description (safe for end-user display) |
| `status` | number | HTTP status code |
| `requestId` | string | Correlation ID for cross-service log tracing (see [observability.md &sect;1.4](./infrastructure/observability.md#14-request-correlation)) |

For `207 Multi-Status` responses on batch ingestion, per-event errors use the same shape inside a `results` array:

```json
{
  "results": [
    { "status": "accepted" },
    { "status": "rejected", "error": { "code": "YAVIO-2100", "message": "Event failed schema validation" } }
  ]
}
```

## Log Correlation

Every error is logged with the code in the `err.code` field:

```json
{
  "level": 50,
  "time": 1710496200000,
  "service": "ingest",
  "requestId": "req_a1b2c3",
  "err": {
    "code": "YAVIO-2003",
    "message": "API key has been revoked",
    "stack": "..."
  },
  "msg": "authentication failed"
}
```

## Sentry Correlation

Errors captured by Sentry include the code as a tag:

| Sentry Field | Value |
|-------------|-------|
| `tags.yavio_error_code` | `YAVIO-2003` |
| `tags.service` | `ingest` |
| `contexts.error.code` | `YAVIO-2003` |
| `contexts.error.category` | `authentication` |

## Prometheus Correlation

Error counters use the code in the `reason` label:

```
yavio_ingest_events_rejected_total{reason="YAVIO-2003"} 42
yavio_dashboard_auth_failures_total{reason="YAVIO-3100"} 7
yavio_intelligence_llm_call_errors_total{error_type="YAVIO-4200"} 3
```

---

## Code Ranges

| Range | Service | Owner |
|-------|---------|-------|
| `YAVIO-1000` &ndash; `YAVIO-1999` | SDK (`@yavio/sdk`) | SDK team |
| `YAVIO-2000` &ndash; `YAVIO-2999` | Ingestion API (`yavio-ingest`) | Backend team |
| `YAVIO-3000` &ndash; `YAVIO-3999` | Dashboard (`yavio-dashboard`) | Frontend team |
| `YAVIO-4000` &ndash; `YAVIO-4999` | Intelligence Service (`yavio-intelligence`) | Intelligence team |
| `YAVIO-5000` &ndash; `YAVIO-5999` | Database / Storage | Infrastructure team |
| `YAVIO-6000` &ndash; `YAVIO-6999` | CLI (`@yavio/cli`) | SDK team |
| `YAVIO-7000` &ndash; `YAVIO-7999` | Infrastructure / Cross-Service | Infrastructure team |

---

## YAVIO-1000 &ndash; YAVIO-1999: SDK

Errors originating in the `@yavio/sdk` SDK (both server and widget entry points). These errors are logged client-side. The SDK never throws &mdash; it logs errors and degrades gracefully.

### Configuration (1000&ndash;1099)

| Code | Severity | Message | Description | Recovery |
|------|----------|---------|-------------|----------|
| `YAVIO-1000` | warn | No API key found | `withYavio()` found no API key in code options, `YAVIO_API_KEY` env var, or `.yaviorc.json`. SDK operates as a transparent pass-through proxy. | Provide API key via any of the three config sources. |
| `YAVIO-1001` | warn | Invalid API key format | API key does not match `yav_` prefix pattern. | Use a valid key from the dashboard. |
| `YAVIO-1002` | error | Invalid endpoint URL | The `endpoint` option, `YAVIO_ENDPOINT` or the file's `endpoint` is set to a non-empty value that is not an http(s) URL (`localhost:3001/v1/events` — no scheme, parses as protocol `localhost:` —, `htps://…`, a bare host). The SDK runs in **no-op mode**: no transport, no widget-token mint, no signal listeners, nothing is sent anywhere. The hosted default is never substituted for an explicit endpoint, so a self-hosted integrator's typo cannot reroute their events and API key to the hosted service. An empty or whitespace-only value counts as unset and takes the default without a message. Logged once per process. | Fix the endpoint URL (`http://` or `https://`, e.g. `http://localhost:3001/v1/events`), or unset it to use the hosted endpoint. |
| `YAVIO-1003` | info | Configuration loaded from .yaviorc.json | Config file discovered and parsed. Informational log, not an error. | N/A |
| `YAVIO-1004` | warn | Malformed .yaviorc.json | Config file exists but cannot be parsed as JSON or is missing required fields. | Re-run `yavio init` or fix the file manually. |
| `YAVIO-1005` | warn | Unsupported .yaviorc.json version | Config file `version` field is higher than the SDK supports. | Update the SDK to the latest version, or re-run `yavio init`. |
| `YAVIO-1006` | warn | Invalid capture option | `capture.geo` is not exactly `true`, `false`, `"country"` or `"region"` (e.g. the string `"false"` from a hand-written `.yaviorc.json`). Fails closed: location capture is turned **off**. Logged once per process. Also: `shutdownTimeoutMs` (option, `YAVIO_SHUTDOWN_TIMEOUT_MS`, file) is not an integer in [100, 2147483647] milliseconds — the default 4 s is used (#142, 4 s since #148; the lower bound catches a seconds-for-milliseconds slip, the upper one is Node's `setTimeout` limit, above which the timer fires after 1 ms). Also: `sessionKey` is set to something that is not a function (a header name instead of a callback, `null`) — it is ignored, as if not set (#144); the message names the type, never the value. Also: `flushTimeoutMs` (option, `YAVIO_FLUSH_TIMEOUT_MS`, file) is not an integer in [100, 2147483647] milliseconds — the default 1 s is used, one line per process, the same rule as `shutdownTimeoutMs` (#171). The same for `waitUntilTimeoutMs` (option, `YAVIO_WAIT_UNTIL_TIMEOUT_MS`, file), default 10 s (#171 review round 2). | Use one of the four values; an integer between 100 and 2147483647 for `shutdownTimeoutMs`, `flushTimeoutMs` and `waitUntilTimeoutMs`; a function `(request) => string \| undefined` for `sessionKey`. |

### Proxy & Instrumentation (1100&ndash;1199)

| Code | Severity | Message | Description | Recovery |
|------|----------|---------|-------------|----------|
| `YAVIO-1100` | error | Proxy interception failed | JavaScript Proxy handler threw during tool call instrumentation. The original tool call is still executed. | Report the bug. SDK falls back to uninstrumented call. |
| `YAVIO-1101` | warn | Platform detection failed | Could not determine AI platform from transport/headers. Platform recorded as `unknown`. | No action needed. Platform may be reclassified in future SDK versions. |
| `YAVIO-1102` | warn | Session key failed | The integrator's `sessionKey` option (#144) threw, returned a thenable (an `async` function; its rejection is caught), a non-string (`null` included) or a string longer than 1 024 characters. The call is recorded without a session key — on an HTTP request a session of its own for the call (`session_source` `per_request`, #169), otherwise the connection's own session (`connection`) — and is itself unaffected (`openCallContext()` runs outside McpServer's error handling, so nothing escapes it). Logged once per process with the first failure's reason (a thrown error's name and message, cut to 200 characters). Emitted since 0.5.4; before, the code was defined but never emitted, and this row described an `initialize`-based derivation the SDK never had. | Make `sessionKey` synchronous and return a conversation id of at most 1 024 characters, or `undefined` / `""` for none. |
| `YAVIO-1103` | warn | Widget token minting failed | `POST /v1/widget-tokens` returned an error, was unreachable or did not answer within 2 s (the mint runs inside the tool call and is aborted then; the result is returned without `_meta.yavio`). Logged once per process. Widget falls back to no-op mode. | Check ingestion API availability and API key validity. |
| `YAVIO-1104` | warn | Widget config injection skipped | Response interception could not detect `_meta.ui.resourceUri` or injection failed. Widget operates without analytics. | Ensure tool response follows MCP widget response format. |
| `YAVIO-1105` | warn | Context unavailable | A tracking call (`yavio.conversion()`, `track()`, `step()`, `identify()`) ran with no active `AsyncLocalStorage` request store — typically from a tool registered on the unwrapped server. The event has no `trace_id`/`session_id` to attach to and is **dropped**. Logged once per process; never in no-op mode. | Register the tool through `withYavio()`; use the `tools` overrides to limit what is captured for it instead of leaving it unwrapped. |
| `YAVIO-1106` | warn | Tool response inspection failed | Error inspecting tool handler response for size, content type, or zero-result detection. Event captured without response metadata. | Report the bug. |
| `YAVIO-1107` | error | Unsupported server | `withYavio()` / `createYavio().wrap()` received a value without a `registerTool` and a `connect` function — not an MCP SDK v1 or v2 `McpServer`; the message names the entry point that was called, and the check runs in no-op mode too. The value is returned **unwrapped** (no instrumentation; from `withYavio()` also no transport and no listeners, decided before the configuration is resolved — `createYavio().wrap()` already holds the client's shared transport), so the integrator's server keeps working. Logged once per process. | Pass the `McpServer` instance itself (`@modelcontextprotocol/sdk` ≥ 1.24.0 or `@modelcontextprotocol/server` 2.x), not a transport, a handler or a framework facade. |
| `YAVIO-1108` | warn | Re-wrap options ignored | `withYavio()` or `createYavio().wrap()` was called on a server that is already wrapped, with any differing resolved option — endpoint, API key, `capture` flags, `tools` overrides, `serverOnly`, intent settings, the presence of `sessionKey` (#144) — or `wrap()` after a `withYavio()` (which would instrument the tools registered before the first wrap). The first wrap wins: the existing proxy is returned and its configuration keeps applying; the later options are ignored. Logged once per process. | Wrap each server once, with the options it should have; create the client once per process and wrap each server as it is built. |

### Transport & Delivery (1200&ndash;1299)

| Code | Severity | Message | Description | Recovery |
|------|----------|---------|-------------|----------|
| `YAVIO-1200` | warn | Event flush failed (retrying) | HTTP POST to ingestion API failed. Retrying with exponential backoff. A 5xx's `Retry-After` is honoured like a 429's since 0.5.5 (ingest's backpressure 503 sends `Retry-After: 1`), and a flush never cuts it. A `flush()` retries a batch that waits for its retry at once when its last attempt is at least a second old, once per flush (#171, review round 1): that attempt does not count towards the retries and its failure prints no line — the flush's `YAVIO-1208` covers it — so a host that flushes after every request does not print one per request during an outage. | Transient. Check network connectivity and ingestion API health. |
| `YAVIO-1201` | error | Event flush failed (max retries) | All retry attempts exhausted. Events dropped from buffer. Also a batch that cannot be serialized (a BigInt or a circular value in an event's metadata): dropped with one line, `Could not serialize a batch of N events`, and the next batch still goes out (#148 review round 3). | Check ingestion API health. Events are lost. |
| `YAVIO-1202` | warn | Event flush rate-limited | Ingestion API returned `429`. SDK will retry with `Retry-After`. | Reduce event volume or increase rate limits. |
| `YAVIO-1203` | error | Authentication rejected (permanent) | Ingestion API returned `401`. SDK stops retrying. No further events will be sent: the batch, everything queued and every later `send()` are dropped and counted as delivery failures, the line carries the count (`API key rejected — stopping delivery; N events dropped`), and a shutdown drain in progress ends instead of sending every remaining batch into the same 401 (#148 review round 3); the flush timer stops and the registry forgets the transport at once (review round 5). The transport is shared per `(endpoint, apiKey)` since 0.5.0, so every wrap and every `createYavio()` client using that key in the process stops delivering — the key is invalid for all of them alike. | Check that the API key is valid and not revoked. |
| `YAVIO-1204` | warn | Partial batch rejection | Ingestion API returned `207`: the batch is accepted and the rejected events of it are dropped, not re-sent — a rejection is a schema or field-limit violation, deterministic, and a retry would get the same answer. The line carries the count (`N events rejected`). A `207` whose body cannot be read is taken as accepted in full, with a note on stderr (`[yavio] 207 body unreadable, batch accepted: …`; #148 review round 4, on stderr since #174). | Rejected events have validation errors; check event schemas. The rejected events are lost. |
| `YAVIO-1205` | warn | Shutdown deadline reached, events not delivered | The shutdown deadline (`shutdownTimeoutMs`, 4 s by default; on a signal one deadline for the whole process at signal + D) ran out with events still queued, in flight (the fetch is aborted), refused after it, or given up because a retry would have ended past it. One line per signal cycle with the exact count across every transport, printed before the signal is re-raised (`Shutdown deadline of 4000 ms reached — N events not delivered …`) — after a `SIGTERM` that followed the cycle's `SIGINT`, a client's stop sequence (Claude Code 2.1.310 on macOS and Linux: `SIGINT`, `SIGTERM` 100 ms later, `SIGKILL` 400 ms after that) that ends the cycle by SIGINT + 400 ms (or SIGTERM + 300 ms, when that is sooner), it names that bound and when the `SIGTERM` came, with the client hint in place of the raise hint (`Shutdown deadline of 400 ms (SIGTERM 102 ms after SIGINT) reached — N events not delivered (queued, in flight or refused after the deadline). The client stops the server with SIGINT, SIGTERM and SIGKILL (Claude Code: 100 ms, then 400 ms); a higher shutdownTimeoutMs does not extend that.`), and so do the cycle's later lines and the exit line after a `shutdown()` that bound cut (#175, 0.5.6) — plus one more line with the same wording when the cycle was handed back before its stops settled (a second signal, or its deadline with a stop still settling) — at the deadline when a `shutdown()` is still waiting then, otherwise once its stops have settled — with what was given up since that the first line had not counted (what is lost after a line at the deadline is the exit line's) — the cycle's only line when the first had nothing to count, as after a second signal well before the deadline next to an app listener; one line per non-signal `shutdown()` that timed out (`shutdown() deadline of … ms reached — N events not delivered`), the last client's on a key a `withYavio()` call pins included when that client never wrapped a server, other holders or not (#179, 0.5.6 — one that wraps only drains such a key, as in 0.5.5, review rounds 2 and 3: that `shutdown()` stops the transport now; before, it only drained it and the loss came at exit as `Process exit with …`); one line at `exit` for what was counted after that, which covers an app that calls `process.exit()` before its `shutdown()` resolved (`Process exit with N events not delivered — await analytics.shutdown() before exiting …`); after a `shutdown()` that returned in that signal cycle, once its deadline has come and with none in progress, that exit line is the deadline's, for what it left — a late request's batch it cut in flight, events queued behind such a batch, a send in its last 100 ms — and says so without that hint (`Shutdown deadline of D ms reached — N [more ]events not delivered (in flight when the deadline cut it, sent in its last 100 ms or after it, or queued behind a request it cut)`, "more" only after a line of that cycle, #154). An exit with nothing queued prints nothing (#148). A `process.exit()` with events queued and no earlier signal or `shutdown()` prints nothing and loses the queue: it emits no `beforeExit`, and the exit hook is not armed (#148; unchanged by #167). A natural exit with events queued — no signal, no `shutdown()`: a stdio server whose client closed stdin, a script, a host that closed its server without a signal — drains on `beforeExit` within min(1.5 s, D) and prints, at exit, one line for what it gave up, across every transport (`Exit deadline of 1500 ms reached — N events not delivered (the process ended on its own with events queued; queued, in flight or refused after the deadline). To wait longer, await analytics.shutdown() before the event loop empties (on stdin's end or at the end of the script; a beforeExit listener is too late).`), with that hint instead of the raise hint, because a higher `shutdownTimeoutMs` does not raise this bound; its stops print no `shutdown() deadline` line, and a signal during the drain takes it over, the cycle's line being the report (#167). | Raise `shutdownTimeoutMs` (or `YAVIO_SHUTDOWN_TIMEOUT_MS`) if the platform's grace period allows — rule of thumb: the close cap + 1 s — or find out why ingest is slow or unreachable; after a client's `SIGINT` → `SIGTERM` stop sequence a higher value does not help, the bound is the client's (SIGINT + 400 ms); after a natural exit, to wait longer than 1.5 s, await `analytics.shutdown()` before the event loop empties (on stdin's end or at the end of the script) — a `beforeExit` listener is too late: registered after `createYavio()` it runs after the SDK's, and its `shutdown()` only waits for the 1.5 s drain. The events in the line are lost. |
| `YAVIO-1206` | warn | Buffer overflow (events dropped) | In-memory buffer exceeded max capacity (10,000 server / 200 widget). Oldest events dropped. | Reduce event volume or increase flush frequency. |
| `YAVIO-1207` | warn | Beacon delivery failed | Widget `navigator.sendBeacon()` returned `false` on teardown. Final events may be lost. | Browser limitation. No recovery. |
| `YAVIO-1208` | warn | Flush incomplete | A `createYavio().flush()` (or `flushWhenSent()`) ended with events undelivered (#171): `flush() left N events undelivered — ingest did not answer within 1000 ms` (its `flushTimeoutMs`, cut to what a signal cycle leaves), or `— ingest failed a batch, which waits for its retry` (the early retry failed too, and the next retry wait ends past the deadline). Nothing is dropped: the events stay queued and go out with a later `flush()`, the flush interval or `shutdown()` — on a host that freezes after the response, with the next invocation's flush. Printed once per stall per endpoint and API key, again only after a flush delivered everything, and at most once a minute per key (#171 review round 4): a second stall within a minute of the last line is reported by the first flush after the minute that still leaves events undelivered (round 5), and a stall that ends within the minute prints nothing. Not by a flush that gave up waiting on another running flush's batch: that flush carries its events and reports for them. Not while the process drains after a signal (the cycle's `YAVIO-1205` counts what is lost then). | Check ingest health and the network path. Raise `flushTimeoutMs` (or `YAVIO_FLUSH_TIMEOUT_MS`) if ingest is consistently slower than 1 s, keeping it well inside the function's own timeout when the flush is awaited. |

### Validation & PII (1300&ndash;1399)

| Code | Severity | Message | Description | Recovery |
|------|----------|---------|-------------|----------|
| `YAVIO-1300` | warn | Event validation failed (dropped) | Event does not match expected schema. Dropped before buffering. | Fix the event payload. |
| `YAVIO-1301` | warn | PII stripping failed (event dropped) | SDK-side PII regex threw an error. Event dropped as a safety measure. | Report the bug. Server-side PII stripping still applies to events that make it through. |
| `YAVIO-1302` | warn | Identify userId conflict | `.identify()` called with a different `userId` than a previous call in the same session. Second call ignored, no `identify` event sent. Per process and best effort: the session state lives in the process's session store, so another instance of a stateless fleet, or the same process after the session was evicted, does not see the first `userId` and accepts another; the read side counts the session's events for its first identified user (#145). | A session can only be bound to one user. |
| `YAVIO-1303` | warn | Conversion missing required fields | `.conversion()` called without `value` or `currency`. Event dropped. | Provide `value` (number) and `currency` (string). |
| `YAVIO-1304` | warn | Event payload too large | Single event exceeds 50 KB. Dropped before buffering. | Reduce metadata size. |

### Widget-Specific (1400&ndash;1499)

| Code | Severity | Message | Description | Recovery |
|------|----------|---------|-------------|----------|
| `YAVIO-1400` | info | No widget configuration found | `useYavio()` found no `window.__YAVIO__` or meta tag. Returns no-op instance. | Ensure `withYavio()` is wrapping the server. Normal in dev/test. |
| `YAVIO-1401` | warn | Widget JWT expired | JWT `exp` claim is in the past. Events will be rejected with `401`. | Widget session has expired. Token refresh not available in v1. |
| `YAVIO-1402` | warn | Widget trace ID mismatch | Event `traceId` does not match `window.__YAVIO__.traceId`. Event dropped. | Internal consistency error. Report the bug. |

---

## YAVIO-2000 &ndash; YAVIO-2999: Ingestion API

Errors from the `yavio-ingest` service. These appear in HTTP responses, Pino logs, Sentry, and Prometheus metrics.

### Authentication (2000&ndash;2099)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-2000` | 401 | Missing authorization header | Request has no `Authorization` header. | Include `Authorization: Bearer <key\|jwt>` header. |
| `YAVIO-2001` | 401 | Invalid API key | API key does not exist in PostgreSQL or hash mismatch. | Use a valid key from the dashboard. |
| `YAVIO-2002` | 401 | API key expired | API key has an `expires_at` in the past. | Generate a new key from the dashboard. |
| `YAVIO-2003` | 401 | API key revoked | API key has a `revoked_at` timestamp set. | Generate a new key or use an active key. |
| `YAVIO-2004` | 401 | Invalid widget JWT | JWT signature verification failed. | Token was tampered with or signed with wrong secret. |
| `YAVIO-2005` | 401 | Widget JWT expired | JWT `exp` claim is in the past. | Mint a new token via `POST /v1/widget-tokens`. |
| `YAVIO-2006` | 401 | Malformed bearer token | Token is neither a valid `yav_` key nor a parseable JWT. | Check the Authorization header format. |

### Rate Limiting (2050&ndash;2099)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-2050` | 429 | API key rate limit exceeded | Sustained event rate exceeds 1,000 events/second for this key. | Reduce event volume. Retry with `Retry-After` header. |
| `YAVIO-2051` | 429 | API key burst limit exceeded | Burst exceeds 5,000 events. | Spread events over time. Retry with `Retry-After` header. |
| `YAVIO-2052` | 429 | IP rate limit exceeded | Unauthenticated IP exceeded 10 requests/second. | Authenticate requests or reduce request rate. |
| `YAVIO-2053` | 429 | Widget token rate limit exceeded | Widget JWT exceeded 50 events per session. | Expected ceiling for widget interactions. |

### Schema Validation (2100&ndash;2199)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-2100` | 400 | Event schema validation failed | Event does not conform to the expected schema. | Check event payload against the event schema in [metrics/events.md](./metrics/events.md). |
| `YAVIO-2101` | 400 | Missing required field | A required field (`event_type`, `event_name`, `timestamp`, `trace_id`, `session_id`) is missing. | Include all required fields. |
| `YAVIO-2102` | 400 | Invalid event_type | `event_type` is not one of the allowed values. | Use a valid event type: `tool_call`, `step`, `conversion`, `identify`, `custom`, `connection`, `tool_discovery`, `resource_access`, `widget_render`, `widget_interaction`, `widget_error`. |
| `YAVIO-2103` | 400 | Invalid timestamp format | `timestamp` is not a valid ISO-8601 string. | Use ISO-8601 format (e.g., `2026-03-15T10:30:00.123Z`). |
| `YAVIO-2104` | 400 | event_name exceeds max length | `event_name` exceeds 256 characters. Event rejected. | Use shorter event names. |
| `YAVIO-2105` | 400 | user_id exceeds max length | `user_id` exceeds 256 characters. Event rejected. | Use shorter user identifiers. |
| `YAVIO-2106` | 400 | trace_id exceeds max length | `trace_id` exceeds 128 characters. Event rejected. | Use standard trace IDs (e.g., `tr_` + nanoid). |
| `YAVIO-2107` | 400 | session_id exceeds max length | `session_id` exceeds 128 characters. Event rejected. | Use standard session IDs (e.g., `ses_` + nanoid). |
| `YAVIO-2108` | 400 | Event exceeds max size | Total serialized event exceeds 50 KB. Event rejected. | Reduce metadata and field sizes. |
| `YAVIO-2109` | 400 | Empty or missing request body | Request body is empty, missing, or not valid JSON. | Send a JSON body with a `batch` array. |
| `YAVIO-2110` | 400 | Empty batch array | `batch` array is present but empty. | Include at least one event in the batch. |
| `YAVIO-2111` | 413 | Batch exceeds max size | Total batch payload exceeds 500 KB. Entire batch rejected. | Split into smaller batches. |
| `YAVIO-2112` | 400 | Widget trace ID mismatch | Widget JWT `tid` claim does not match event `trace_id`. Entire batch rejected. | Ensure all events in the batch match the JWT trace scope. |

### Field Truncation (2200&ndash;2249)

These are informational &mdash; the event is accepted, but oversized fields are truncated before storage.

| Code | HTTP | Message | Description |
|------|------|---------|-------------|
| `YAVIO-2200` | N/A | metadata field truncated | `metadata` JSON exceeds 10 KB. Replaced with `{"_truncated": true, "_original_size": <bytes>}`. |
| `YAVIO-2201` | N/A | user_traits field truncated | `user_traits` JSON exceeds 5 KB. Same truncation behavior. |
| `YAVIO-2202` | N/A | error_message field truncated | `error_message` exceeds 2 KB. Truncated with `... [truncated]` suffix. |
| `YAVIO-2203` | N/A | input_keys field truncated | `input_keys` JSON exceeds 5 KB. Truncated. |
| `YAVIO-2204` | N/A | input_types field truncated | `input_types` JSON exceeds 5 KB. Truncated. |
| `YAVIO-2205` | N/A | intent_signals field truncated | `intent_signals` JSON exceeds 2 KB. Truncated. |

### PII Stripping (2250&ndash;2299)

| Code | Severity | Message | Description | Recovery |
|------|----------|---------|-------------|----------|
| `YAVIO-2250` | error | PII stripping engine failed | Server-side PII regex threw an unexpected error on a batch. Events still written (fail-open for availability). Sentry alert triggered. | Report the bug. PII may have been written to ClickHouse for this batch. |
| `YAVIO-2251` | info | PII patterns detected and redacted | Informational. PII was found and replaced in event fields. | No action needed. Working as intended. |

### Widget Token Endpoint (2300&ndash;2349)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-2300` | 400 | Missing or invalid traceId | `POST /v1/widget-tokens` body is missing `traceId` or it is not a string. | Include a valid `traceId` in the request body. |
| `YAVIO-2301` | 400 | Missing sessionId | `POST /v1/widget-tokens` body is missing `sessionId`. | Include a valid `sessionId` in the request body. |
| `YAVIO-2302` | 401 | Unauthorized for widget token minting | API key validation failed for the token minting request. | Use a valid, non-revoked API key. |
| `YAVIO-2303` | 429 | Widget token rate limited | Too many token minting requests. | Reduce token minting frequency. |

### Storage & Pipeline (2400&ndash;2499)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-2400` | 503 | ClickHouse write failed (retrying) | Batch insert to ClickHouse failed. Retrying with exponential backoff (up to 3 attempts). | Transient. Check ClickHouse health. |
| `YAVIO-2401` | 503 | ClickHouse write failed (max retries) | All retry attempts exhausted. Batch dropped. Sentry alert triggered. | Check ClickHouse connectivity, disk space, and query load. SDK-level retries provide additional recovery. |
| `YAVIO-2402` | 503 | Backpressure active | Write buffer exceeds 100,000 events. New events rejected with `Retry-After` header. | ClickHouse is overloaded or unavailable. Wait for buffer to drain. |
| `YAVIO-2403` | 503 | PostgreSQL unavailable | API key cache miss and PostgreSQL is unreachable for key lookup. | Check PostgreSQL connectivity. Cached keys still work. |
| `YAVIO-2404` | N/A | API key cache miss | Informational. API key not in cache; querying PostgreSQL. | No action needed. Normal cache behavior. |

### Catch-All (2999)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-2999` | 500 | Internal ingestion error | Unhandled exception in ingestion API. Captured by Sentry. | Report the bug. Check Sentry for stack trace. |

---

## YAVIO-3000 &ndash; YAVIO-3999: Dashboard

Errors from the `yavio-dashboard` Next.js application. These appear in API responses, Pino logs (server-side), browser console (client-side), and Sentry.

### Authentication (3000&ndash;3099)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-3000` | 401 | Session expired | Session cookie is missing, invalid, or expired. | Re-authenticate. User is redirected to login. |
| `YAVIO-3001` | 401 | Invalid credentials | Email/password combination does not match. | Check email and password. |
| `YAVIO-3002` | 403 | Email not verified | Account exists but email has not been verified. | Check inbox for verification email. Resend if needed. |
| `YAVIO-3003` | 403 | Account locked (brute-force) | 10+ failed login attempts within 15 minutes. Account locked for 15 minutes. | Wait for auto-unlock or reset password. |
| `YAVIO-3004` | 403 | Account locked (escalated) | 25+ failed login attempts within 1 hour. Account locked for 1 hour. User notified via email. | Wait for auto-unlock or reset password. |
| `YAVIO-3005` | 403 | Account locked (CAPTCHA required) | 50+ failed login attempts within 24 hours. Manual unlock required. | Use email link or reset password to unlock. |
| `YAVIO-3006` | 400 | Invalid password reset token | Token is malformed, expired (>1 hour), or already used. | Request a new password reset email. |
| `YAVIO-3007` | 400 | Invalid email verification token | Verification token is malformed, expired, or already used. | Request a new verification email. |
| `YAVIO-3008` | 400 | Invalid invite token | Workspace invitation token is invalid or expired. | Request a new invitation from the workspace admin. |
| `YAVIO-3009` | 400 | OAuth error | OAuth flow failed (provider returned an error, state mismatch, or code exchange failed). | Retry the OAuth flow. Check OAuth provider configuration. |
| `YAVIO-3010` | 403 | CSRF validation failed | CSRF token is missing or does not match. | Reload the page and retry. |
| `YAVIO-3011` | 403 | Origin validation failed | Request `Origin` header does not match `NEXTAUTH_URL`. | Requests must originate from the dashboard domain. |

### Authorization (3100&ndash;3149)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-3100` | 403 | Insufficient role | User's role does not permit the requested action (e.g., Member trying to manage members). | Contact a workspace Admin. |
| `YAVIO-3101` | 403 | Workspace owner cannot be removed | Attempted to remove or downgrade the workspace owner. | The owner role is permanent. Transfer ownership first (future feature). |
| `YAVIO-3102` | 403 | Not a workspace member | User is not a member of the requested workspace. | Request an invitation from a workspace Admin. |
| `YAVIO-3103` | 403 | Viewer export denied | Viewer role attempted to export analytics data. | Contact a workspace Admin for role upgrade. |

### Workspace & Project Management (3150&ndash;3249)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-3150` | 409 | Workspace slug already exists | The requested workspace slug is taken. | Choose a different slug. |
| `YAVIO-3151` | 404 | Workspace not found | The workspace ID or slug does not exist or user lacks access. | Check the URL. |
| `YAVIO-3152` | 409 | Project slug already exists | The requested project slug is taken within this workspace. | Choose a different slug. |
| `YAVIO-3153` | 404 | Project not found | The project ID or slug does not exist within this workspace. | Check the URL. |
| `YAVIO-3154` | 400 | Invalid workspace name | Name is empty, too long, or contains invalid characters. | Use 1-100 alphanumeric characters. |
| `YAVIO-3155` | 400 | Invalid project name | Name is empty, too long, or contains invalid characters. | Use 1-100 alphanumeric characters. |
| `YAVIO-3156` | 400 | Invalid slug format | Slug contains invalid characters or is a reserved word. | Use lowercase alphanumeric characters and hyphens. |

### API Key Management (3250&ndash;3299)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-3250` | 404 | API key not found | Key ID does not exist or belongs to a different project. | Check the key ID. |
| `YAVIO-3251` | 409 | API key already revoked | Attempted to revoke a key that is already revoked. | No action needed. |
| `YAVIO-3252` | 400 | Invalid key name | Key name is empty or too long. | Use 1-100 characters. |
| `YAVIO-3253` | 400 | Invalid grace period | Rotation grace period is negative or exceeds maximum (1440 minutes / 24 hours). | Use a value between 0 and 1440. |

### Member & Invitation Management (3300&ndash;3349)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-3300` | 404 | Member not found | Member ID does not exist in this workspace. | Check the member ID. |
| `YAVIO-3301` | 409 | User already a member | Invited email is already a workspace member. | No action needed. |
| `YAVIO-3302` | 409 | Invitation already pending | An invitation for this email is already pending. | Wait for the existing invitation to be accepted or cancel it first. |
| `YAVIO-3303` | 400 | Invalid role | Role is not one of `admin`, `member`, `viewer`. | Use a valid role. |
| `YAVIO-3304` | 404 | Invitation not found | Invitation ID does not exist. | Check the invitation ID. |

### Analytics Queries (3400&ndash;3499)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-3400` | 400 | Invalid time range | `from` is after `to`, or date format is invalid. | Fix the date parameters. |
| `YAVIO-3401` | 400 | Invalid granularity | `granularity` is not one of `hour`, `day`, `week`, `month`. | Use a valid granularity. |
| `YAVIO-3402` | 400 | Invalid platform filter | `platform` value is not recognized. | Use `chatgpt`, `claude`, `cursor`, `vscode`, or omit for all. |
| `YAVIO-3403` | 400 | Invalid pagination | `page` < 1, `pageSize` < 1 or > 100. | Fix pagination parameters. |
| `YAVIO-3404` | 400 | Invalid sort parameter | Sort field is not a valid column for this endpoint. | Check the API documentation for valid sort fields. |
| `YAVIO-3405` | 504 | Analytics query timeout | The query ran out of time: ClickHouse cut it at the query's time limit (`max_execution_time`, code 159 `TIMEOUT_EXCEEDED`: 30 seconds for the MCP `run_query` tool, 25 seconds for funnels), or the dashboard's own 30-second request timeout to ClickHouse ran out. Recognized by the error code, not the message text (#157). | Narrow the time range or reduce query complexity. |
| `YAVIO-3406` | 502 | ClickHouse unavailable | ClickHouse is unreachable from the dashboard, or failed the query with a transient server error (overload, too many simultaneous queries, network, the server's total or the user's memory limit, which depend on what else runs at the same time). | Retry later; check ClickHouse health. Partial data may be rendered with an error message. |
| `YAVIO-3407` | 400 | Analytics query rejected | ClickHouse parsed the query and refused it (unknown column, bad function, budget exceeded). Permanent — the same query will fail again. | Fix the query. Raised by the MCP `run_query` tool for model-authored SQL; dashboard-authored queries hitting this indicate schema drift. |
| `YAVIO-3408` | 422 | Analytics query memory limit exceeded | ClickHouse stopped the query at its own memory limit (code 241 `MEMORY_LIMIT_EXCEEDED` from the query's `max_memory_usage`, text "Query memory limit exceeded" or "Memory limit (for query) exceeded"). The same query over the same range needs the same memory, so a retry is not the fix (#157). A 241 from the server's total or the user's limit is load-dependent and stays `YAVIO-3406`. | Narrow the time range or simplify the query (fewer groups, fewer distinct values). |

### Live Feed (3500&ndash;3549)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-3500` | 429 | SSE connection limit exceeded | User has exceeded 5 concurrent SSE connections. | Close existing live feed tabs. |
| `YAVIO-3501` | 503 | Live feed unavailable | ClickHouse polling failed. SSE stream interrupted. | Client auto-reconnects. Check ClickHouse health. |

### Billing (3600&ndash;3699)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-3600` | 400 | Billing not available | `YAVIO_CLOUD` is not enabled. Billing routes return Cloud upsell info. | Self-hosted deployment. Billing is Cloud-only. |
| `YAVIO-3601` | 400 | Invalid spending cap | Spending cap value is negative. | Use 0 (to remove cap) or a positive number. |
| `YAVIO-3602` | 400 | Stripe checkout creation failed | Stripe API returned an error when creating a checkout session. | Retry. Check Stripe configuration. |
| `YAVIO-3603` | 400 | Stripe webhook signature invalid | `Stripe-Signature` header verification failed. | Check webhook signing secret configuration. |
| `YAVIO-3604` | 402 | Payment past due | Workspace billing status is `past_due`. | Update payment method in Stripe portal. |
| `YAVIO-3605` | 400 | No active subscription | Workspace has no Stripe subscription. | Complete checkout flow first. |
| `YAVIO-3606` | 403 | Tier limit exceeded | Operation exceeds the current pricing tier limits (e.g., project count, member count). | Upgrade tier or remove existing resources. |

### Account Management (3700&ndash;3749)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-3700` | 400 | Account deletion requires password | `DELETE /api/auth/account` is missing password confirmation. | Include current password in request body. |
| `YAVIO-3701` | 400 | Invalid password | Password confirmation does not match. | Enter the correct current password. |
| `YAVIO-3702` | 409 | Email already registered | Registration email is already associated with an account. | Login instead, or use a different email. |
| `YAVIO-3703` | 400 | Password too weak | Password does not meet minimum requirements (8+ characters). | Use a stronger password. |

### Rate Limiting (3800&ndash;3849)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-3800` | 429 | Auth route rate limited | Exceeded 10 requests/minute on auth routes. | Wait and retry. |
| `YAVIO-3801` | 429 | Analytics query rate limited | Exceeded 60 requests/minute on analytics routes. | Reduce query frequency. Client-side debounce recommended (300ms). |
| `YAVIO-3802` | 429 | Management route rate limited | Exceeded 30 requests/minute on workspace/project/key routes. | Reduce request frequency. |
| `YAVIO-3803` | 429 | Billing route rate limited | Exceeded 20 requests/minute on billing routes. | Reduce request frequency. |

### Catch-All (3999)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-3999` | 500 | Internal dashboard error | Unhandled exception in dashboard. Captured by Sentry (server-side) or `@sentry/nextjs` (client-side). | Report the bug. Check Sentry for stack trace. |

---

## YAVIO-4000 &ndash; YAVIO-4999: Intelligence Service

Errors from the `yavio-intelligence` service. These appear in API responses to the dashboard, Pino logs, Sentry, and Prometheus metrics.

### Authentication & Licensing (4000&ndash;4099)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-4000` | 403 | Invalid license | License key is missing, expired, or invalid. Premium features disabled. | Contact Yavio sales or check license configuration. |
| `YAVIO-4001` | 403 | License tier insufficient | Current license does not cover the requested feature. | Upgrade to a higher tier. |
| `YAVIO-4002` | 503 | License validation unavailable | License server is unreachable. Cached license used (24h cache). Falls back to denied if no cache. | Check network connectivity to license server. |
| `YAVIO-4003` | 401 | Unauthorized request | Request to intelligence API lacks valid internal authentication. | Check `YAVIO_INTELLIGENCE_URL` and internal auth configuration. |

### Clustering (4100&ndash;4149)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-4100` | 404 | No clustering results | No clustering results found for this project. Job may not have run yet. | Wait for the next scheduled clustering job or trigger manually. |
| `YAVIO-4101` | 500 | Clustering job failed | k-means or DBSCAN algorithm threw an error. Partial results may be available. Sentry alert triggered. | Check ClickHouse data quality. Report the bug. |
| `YAVIO-4102` | 500 | Clustering data read failed | Could not read session data from ClickHouse for clustering input. | Check ClickHouse connectivity. |
| `YAVIO-4103` | 500 | Clustering results write failed | Could not write clustering results to ClickHouse. | Check ClickHouse write permissions and disk space. |

### LLM & Insights (4200&ndash;4299)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-4200` | 502 | LLM API call failed | External LLM API (OpenAI/Anthropic) returned an error. | Transient. Check LLM API status and API key validity. |
| `YAVIO-4201` | 504 | LLM API timeout | LLM API call exceeded timeout (30 seconds). | Retry. May indicate LLM provider overload. |
| `YAVIO-4202` | 429 | LLM API rate limited | LLM provider returned 429. | Wait and retry. Check usage quotas with LLM provider. |
| `YAVIO-4203` | 500 | Intent classification failed | LLM returned an unparseable response for intent classification. | Check prompt engineering. Report the bug. |
| `YAVIO-4204` | 500 | Insight generation failed | LLM returned an unparseable or empty response for insights. | Check prompt engineering. Report the bug. |
| `YAVIO-4205` | 500 | Digest generation failed | Weekly digest email generation failed. | Check LLM API and email (nodemailer) configuration. |
| `YAVIO-4206` | 502 | Digest email delivery failed | Nodemailer SMTP send failed. Digest generated but not delivered. | Check SMTP configuration. |

### Anomaly Detection (4300&ndash;4349)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-4300` | 404 | No anomalies found | No anomalies detected for this project in the given time range. | Not an error &mdash; system is healthy. |
| `YAVIO-4301` | 500 | Anomaly detection failed | Statistical analysis threw an error. | Check ClickHouse data availability. Report the bug. |
| `YAVIO-4302` | 500 | Anomaly alert dispatch failed | Anomaly detected but notification could not be sent. | Check alert notification configuration. |

### Benchmarking & A/B Testing (4400&ndash;4449)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-4400` | 404 | No benchmark data | Insufficient cross-tenant data for benchmarks. | Feature requires more tenants using Cloud Pro. |
| `YAVIO-4401` | 404 | A/B test not found | Requested A/B test ID does not exist. | Check the A/B test ID. |
| `YAVIO-4402` | 400 | Invalid A/B test configuration | A/B test creation request has invalid parameters. | Check required fields (name, variants, metric). |
| `YAVIO-4403` | 409 | A/B test already exists | A/B test with the same name already exists for this project. | Use a different name or update the existing test. |

### Background Jobs (4500&ndash;4549)

| Code | Severity | Message | Description | Recovery |
|------|----------|---------|-------------|----------|
| `YAVIO-4500` | error | Scheduled job failed | A background job (clustering, anomaly scan, digest) threw an unhandled exception. Captured by Sentry. | Check Sentry for stack trace. Job will be retried on the next schedule. |
| `YAVIO-4501` | warn | Job skipped (previous still running) | A scheduled job was skipped because the previous run is still in progress. | If persistent, the job may be stuck. Check job duration metrics. |
| `YAVIO-4502` | error | Job exceeded timeout | A background job exceeded its maximum allowed duration. | Investigate data volume and ClickHouse performance. |

### Catch-All (4999)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-4999` | 500 | Internal intelligence error | Unhandled exception in intelligence service. Captured by Sentry. | Report the bug. Check Sentry for stack trace. |

---

## YAVIO-5000 &ndash; YAVIO-5999: Database / Storage

Errors related to ClickHouse and PostgreSQL operations. These are typically logged by the service that encountered the error (ingest, dashboard, intelligence) and not returned directly to end users.

### ClickHouse (5000&ndash;5199)

| Code | Severity | Message | Description | Recovery |
|------|----------|---------|-------------|----------|
| `YAVIO-5000` | fatal | ClickHouse connection refused | Cannot establish TCP/HTTP connection to ClickHouse. | Check ClickHouse container health and port binding. |
| `YAVIO-5001` | error | ClickHouse query timeout | Query exceeded configured timeout. | Narrow the query scope or optimize the query. |
| `YAVIO-5002` | error | ClickHouse insert failed | `INSERT` statement returned an error. | Check data format, schema compatibility, and disk space. |
| `YAVIO-5003` | error | ClickHouse schema mismatch | Incoming data does not match the table schema. | Run migrations. Check SDK and ingestion API version compatibility. |
| `YAVIO-5004` | warn | ClickHouse disk usage high | Disk usage exceeds 80% threshold. Prometheus alert triggered. | Add storage or configure TTL policies to expire old data. |
| `YAVIO-5005` | error | ClickHouse merge failed | Background merge operation failed. | Check ClickHouse logs. May indicate disk or memory pressure. |
| `YAVIO-5006` | error | ClickHouse row policy violation | Query blocked by row-level security policy (tenant isolation). | Internal error &mdash; service is querying with incorrect `SQL_workspace_id` / `SQL_project_id`. |
| `YAVIO-5007` | error | ClickHouse migration failed | Schema migration script failed to execute. | Check migration SQL syntax and ClickHouse compatibility. |

### PostgreSQL (5200&ndash;5399)

| Code | Severity | Message | Description | Recovery |
|------|----------|---------|-------------|----------|
| `YAVIO-5200` | fatal | PostgreSQL connection refused | Cannot connect to PostgreSQL. | Check PostgreSQL container health, port binding, and credentials. |
| `YAVIO-5201` | error | PostgreSQL query failed | SQL query returned an error. | Check query syntax and schema compatibility. |
| `YAVIO-5202` | error | PostgreSQL unique constraint violation | Insert/update violates a unique constraint (e.g., duplicate email, slug). | Handle as a conflict (409) in the calling service. |
| `YAVIO-5203` | error | PostgreSQL foreign key violation | Insert/update references a non-existent foreign key. | Check data integrity and cascading deletes. |
| `YAVIO-5204` | error | PostgreSQL RLS policy violation | Query blocked by row-level security policy (`app.current_user_id` not set or mismatched). | Internal error &mdash; `withRLS()` wrapper not used correctly. |
| `YAVIO-5205` | error | PostgreSQL migration failed | Drizzle ORM migration script failed to execute. | Check migration SQL and PostgreSQL compatibility. |
| `YAVIO-5206` | warn | PostgreSQL connection pool exhausted | All connections in the pool are in use. | Increase pool size or optimize long-running queries. |
| `YAVIO-5207` | error | PostgreSQL deadlock detected | Two transactions are waiting on each other. One is rolled back. | Retry the operation. Investigate transaction ordering. |
| `YAVIO-5208` | warn | PostgreSQL disk usage high | Disk usage exceeds threshold. | Add storage or clean up old data. |

---

## YAVIO-6000 &ndash; YAVIO-6999: CLI

Errors from the `@yavio/cli` tool. These are displayed to the developer in the terminal.

### Environment (6000&ndash;6099)

| Code | Message | Description | Recovery |
|------|---------|-------------|----------|
| `YAVIO-6000` | Docker not found | Docker daemon is not running or `docker` is not in PATH. | Install Docker and ensure the daemon is running. |
| `YAVIO-6001` | docker-compose not found | `docker-compose` (or `docker compose`) is not available. | Install Docker Compose v2.20+. |
| `YAVIO-6002` | Node.js version unsupported | Node.js version is below 20. | Upgrade to Node.js 20+. |
| `YAVIO-6003` | Docker version unsupported | Docker version is below 24. | Upgrade Docker. |
| `YAVIO-6004` | docker-compose version unsupported | Docker Compose version is below 2.20. | Upgrade Docker Compose. |
| `YAVIO-6005` | Insufficient memory | System has less than 2 GB available RAM. | Free memory or increase system RAM. |
| `YAVIO-6006` | Insufficient disk space | Data volumes have less than 1 GB free. | Free disk space. |

### Configuration (6100&ndash;6149)

| Code | Message | Description | Recovery |
|------|---------|-------------|----------|
| `YAVIO-6100` | .yaviorc.json not found | `yavio init` has not been run or config file was deleted. | Run `yavio init`. |
| `YAVIO-6101` | Invalid .yaviorc.json | Config file exists but cannot be parsed. | Re-run `yavio init`. |
| `YAVIO-6102` | docker-compose.yml not found | Cannot find the Compose file in `--file`, current directory, or default paths. | Run from the platform directory or specify `--file`. |
| `YAVIO-6103` | Invalid API key | API key in `.yaviorc.json` was rejected by the ingestion API. | Generate a new key from the dashboard. |

### Connectivity (6200&ndash;6249)

| Code | Message | Description | Recovery |
|------|---------|-------------|----------|
| `YAVIO-6200` | Ingestion API unreachable | `GET /health` on the ingestion API timed out or refused. | Start the platform (`yavio up`) or check firewall/network. |
| `YAVIO-6201` | Dashboard unreachable | `GET /api/health` on the dashboard timed out or refused. | Start the platform (`yavio up`) or check firewall/network. |
| `YAVIO-6202` | ClickHouse unreachable | ClickHouse health check failed. | Check ClickHouse container logs. |
| `YAVIO-6203` | PostgreSQL unreachable | `pg_isready` check failed. | Check PostgreSQL container logs. |
| `YAVIO-6204` | DNS resolution failed | Cannot resolve the ingestion endpoint hostname. | Check DNS configuration and network. |

### Port Conflicts (6300&ndash;6349)

| Code | Message | Description | Recovery |
|------|---------|-------------|----------|
| `YAVIO-6300` | Port 3000 in use | Dashboard port is occupied by another process. | Stop the conflicting process or configure an alternate port. |
| `YAVIO-6301` | Port 3001 in use | Ingestion API port is occupied by another process. | Stop the conflicting process or configure an alternate port. |
| `YAVIO-6302` | Port 5432 in use | PostgreSQL port is occupied by another process. | Stop the conflicting process or configure an alternate port. |
| `YAVIO-6303` | Port 8123 in use | ClickHouse HTTP port is occupied by another process. | Stop the conflicting process or configure an alternate port. |
| `YAVIO-6304` | Port 9000 in use | ClickHouse native port is occupied by another process. | Stop the conflicting process or configure an alternate port. |

### Command Errors (6400&ndash;6499)

| Code | Message | Description | Recovery |
|------|---------|-------------|----------|
| `YAVIO-6400` | docker-compose up failed | `docker-compose up -d` exited with a non-zero code. | Check `yavio logs` for container startup errors. |
| `YAVIO-6401` | docker-compose down failed | `docker-compose down` exited with a non-zero code. | Check Docker daemon status. |
| `YAVIO-6402` | Docker image pull failed | `docker-compose pull` could not fetch latest images. | Check network connectivity and Docker Hub / registry access. |
| `YAVIO-6403` | Reset confirmation mismatch | User did not type "reset" to confirm destructive operation. | Type "reset" when prompted, or use `--yes --confirm-destructive`. |
| `YAVIO-6404` | Service not recognized | `yavio logs <service>` was passed an invalid service name. | Use `dashboard`, `ingest`, `clickhouse`, or `postgres`. |

### Catch-All (6999)

| Code | Message | Description | Recovery |
|------|---------|-------------|----------|
| `YAVIO-6999` | Unexpected CLI error | Unhandled exception in CLI. | Report the bug with the full stack trace. |

---

## YAVIO-7000 &ndash; YAVIO-7999: Infrastructure / Cross-Service

Errors related to platform infrastructure, deployment, health checks, and cross-service concerns.

### Health Checks (7000&ndash;7099)

| Code | Severity | Message | Description | Recovery |
|------|----------|---------|-------------|----------|
| `YAVIO-7000` | error | Health check failed | A service health check endpoint returned `503 Unhealthy`. | Check the specific dependency listed in the health response. |
| `YAVIO-7001` | warn | Health check dependency degraded | One dependency is slow (latency > 1s) but still responsive. | Monitor. May indicate impending failure. |
| `YAVIO-7002` | fatal | Health check timeout | Health check did not respond within the configured timeout. | Service may be hung. Restart the container. |

### Observability (7100&ndash;7149)

| Code | Severity | Message | Description | Recovery |
|------|----------|---------|-------------|----------|
| `YAVIO-7100` | warn | Sentry initialization failed | `SENTRY_DSN` is set but Sentry SDK failed to initialize. Error tracking disabled. | Check the DSN format and Sentry service availability. |
| `YAVIO-7101` | warn | OTEL exporter connection failed | `OTEL_EXPORTER_OTLP_ENDPOINT` is set but the exporter cannot connect. Tracing disabled. | Check the OTLP endpoint URL and network connectivity. |
| `YAVIO-7102` | warn | Metrics endpoint auth failed | `/metrics` request received without valid bearer token (when `METRICS_BEARER_TOKEN` is set). | Configure Prometheus with the correct bearer token. |
| `YAVIO-7103` | warn | Sentry event send failed | An error event could not be delivered to Sentry. | Check network connectivity to Sentry. |
| `YAVIO-7104` | warn | Log level invalid | `LOG_LEVEL` env var has an unrecognized value. Defaulting to `info`. | Use one of: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |

### Deployment & Docker (7200&ndash;7249)

| Code | Severity | Message | Description | Recovery |
|------|----------|---------|-------------|----------|
| `YAVIO-7200` | fatal | Required environment variable missing | A required env var (e.g., `DATABASE_URL`, `CLICKHOUSE_URL`, `JWT_SECRET`) is not set. Service refuses to start. | Set the missing env var in `.env` or Docker Compose config. |
| `YAVIO-7201` | fatal | Invalid environment variable | An env var has an invalid format or value. Service refuses to start. | Fix the env var value. |
| `YAVIO-7202` | error | Container OOM killed | Docker killed a container for exceeding memory limits. | Increase memory limits in Docker Compose or optimize memory usage. |
| `YAVIO-7203` | error | Volume mount failed | Docker could not mount a data volume. | Check file permissions and disk availability. |

### TLS & Security (7300&ndash;7349)

| Code | Severity | Message | Description | Recovery |
|------|----------|---------|-------------|----------|
| `YAVIO-7300` | warn | TLS certificate expiring soon | Certificate expires within 14 days. Prometheus alert triggered. | Renew the TLS certificate. |
| `YAVIO-7301` | error | TLS certificate expired | Certificate has expired. HTTPS connections will fail. | Renew the TLS certificate immediately. |
| `YAVIO-7302` | warn | Insecure configuration detected | Service is running without HTTPS in a production environment. | Configure TLS via reverse proxy. |

### CORS (7400&ndash;7449)

| Code | HTTP | Message | Description | Recovery |
|------|------|---------|-------------|----------|
| `YAVIO-7401` | 405 | CORS method not allowed | Request method is not in `Access-Control-Allow-Methods`. | Only `POST` and `OPTIONS` are allowed on ingestion endpoints. |

### Catch-All (7999)

| Code | Severity | Message | Description | Recovery |
|------|----------|---------|-------------|----------|
| `YAVIO-7999` | error | Unexpected infrastructure error | Unhandled infrastructure-level error. Captured by Sentry. | Report the bug. Check Sentry for stack trace. |

---

## Implementation Guide

### Creating a New Error

When adding a new error to any service:

1. **Pick the next available code** in the appropriate range for your service.
2. **Add it to this catalog** with all required fields (code, severity/HTTP, message, description, recovery).
3. **Use the shared error factory** in your service code:

```typescript
// lib/errors.ts (shared pattern across all services)
export class YavioError extends Error {
  constructor(
    public readonly code: string,
    public readonly message: string,
    public readonly status: number,
    public readonly metadata?: Record<string, unknown>
  ) {
    super(message);
    this.name = "YavioError";
  }
}

// Usage
throw new YavioError("YAVIO-2001", "Invalid API key", 401);
```

4. **Error middleware** (Fastify `onError` hook / Next.js error boundary) catches `YavioError` instances and formats the response, log line, and Sentry context automatically:

```typescript
// Error handler middleware (Fastify example)
fastify.setErrorHandler((error, request, reply) => {
  const code = error instanceof YavioError ? error.code : "YAVIO-2999";
  const status = error instanceof YavioError ? error.status : 500;

  request.log.error({ err: { code, message: error.message, stack: error.stack } });

  if (status >= 500) {
    Sentry.captureException(error, { tags: { yavio_error_code: code } });
  }

  reply.status(status).send({
    error: {
      code,
      message: error.message,
      status,
      requestId: request.id,
    },
  });
});
```

### SDK Errors (Client-Side)

SDK errors are never thrown. They are logged to stderr/console and the SDK degrades gracefully:

```typescript
// SDK error logging pattern
function logSdkError(code: string, message: string, meta?: Record<string, unknown>) {
  console.warn(`[yavio] ${code}: ${message}`, meta ?? "");
}

// Usage
logSdkError("YAVIO-1200", "Event flush failed (retrying)", { attempt: 2, maxRetries: 5 });
```

### CLI Errors

CLI errors are displayed to the developer with the code, message, and recovery action:

```
Error YAVIO-6000: Docker not found
  Docker daemon is not running or `docker` is not in PATH.
  Fix: Install Docker and ensure the daemon is running.
```
