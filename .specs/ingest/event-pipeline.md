# 6. Event Processing Pipeline

The event pipeline spans two stages: **SDK-side buffering** (in the developer's MCP server or widget) and **ingestion-side processing** (in the Yavio ingestion API). This two-phase design ensures zero impact on tool call latency while centralizing PII stripping and validation in one trusted location.

## 6.1 SDK-Side: Async Batch Queue

Both the server SDK and widget SDK buffer events in memory before flushing them to the ingestion API via HTTP POST. The queue behavior is identical in both environments (Node.js and browser), with minor differences in shutdown handling.

### 6.1.1 Queue Behavior

| Parameter | Server SDK | Widget SDK |
|-----------|-----------|------------|
| Flush interval | 10 seconds | 5 seconds |
| Max batch size | 100 events | 20 events |
| Max buffer size | 10,000 events | 200 events |
| Backpressure | Drop oldest, log warning | Drop oldest, silent |
| Shutdown | Synchronous `fetch` with `keepalive` on `SIGTERM` | `navigator.sendBeacon()` on `visibilitychange` / unload |
| Retry | 5 retries, exponential backoff (1s–16s) | 3 retries, exponential backoff (1s–4s) |

### 6.1.2 SDK-Side Processing

Each event passes through these stages before entering the memory buffer:

1. **Enrichment:** Adds `timestamp`, `traceId`, `sessionId`, `userId` (if `.identify()` was called), `platform`, `sdkVersion`, `source` (server | widget) if not already present. The `sessionId` is always derived SDK-side: the server SDK derives it from the MCP `initialize` handshake (see [server-sdk.md Section 3.7](../sdk/server-sdk.md#37-session-lifecycle)), and the widget SDK reads it from `window.__YAVIO__.sessionId` (the server's session ID, propagated via the widget JWT). Both server and widget events share the same `session_id`. The ingestion API never generates session IDs.
2. **Input/Output Capture:** For `tool_call` events, serializes the full input arguments and output content as JSON. Derives `inputKeys`, `inputTypes`, and `inputParamsCount` from the input object. Inspects output for size, content types, result count, and zero-result detection.
3. **Schema Validation:** Confirms event matches the expected shape. Malformed events are logged (server) or silently dropped (widget), never sent.
4. **Buffer Insertion:** Event added to in-memory array. If batch size threshold is met, flush is triggered immediately.

> **Note:** PII stripping uses a defense-in-depth strategy across two layers. The **SDK** runs a lightweight, non-configurable best-effort pass that strips common PII patterns (emails, credit cards, SSNs, phone numbers) from event payloads before they leave the process (`core/pii.ts`). This minimizes PII in transit and reduces exposure if the server-side layer has a bug. The **ingestion API** then runs a full configurable scrub as the authoritative safety net before writing to ClickHouse. This ensures PII is caught server-side regardless of SDK version. See [SDK Architecture — PII Strategy](../sdk/architecture.md#pii-strategy) for details.

## 6.2 Ingestion API: Event Processing

The ingestion API (`yavio-ingest` service) receives event batches via `POST /v1/events` and processes them through a pipeline before writing to ClickHouse. It also provides `POST /v1/widget-tokens` for minting short-lived widget JWTs.

### 6.2.1 Authentication: API Keys vs Widget JWTs

The ingestion API accepts two types of credentials:

| Source | Credential | Header | Validation |
|--------|-----------|--------|------------|
| Server SDK | Project API key (`yav_...`) | `Authorization: Bearer yav_...` | Hash-based lookup in PostgreSQL (cached) |
| Widget SDK | Widget JWT (`eyJ...`) | `Authorization: Bearer eyJ...` | Signature verification + expiry check using internal `JWT_SECRET` |

The API distinguishes between the two by inspecting the Bearer token format: tokens starting with `yav_` are API keys; all others are parsed as JWTs.

### 6.2.2 Widget Token Endpoint

**`POST /v1/widget-tokens`** — Mints a short-lived JWT for widget-side event ingestion.

**Request:**
```http
POST /v1/widget-tokens HTTP/1.1
Host: ingest.yavio.ai
Authorization: Bearer yav_abc123...
Content-Type: application/json

{ "traceId": "tr_8f2a...", "sessionId": "ses_abc..." }
```

**Response (200):**
```json
{
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "expiresAt": "2026-03-15T11:00:00Z"
}
```

**JWT Claims:**
```json
{
  "pid": "project-uuid",
  "wid": "workspace-uuid",
  "tid": "tr_8f2a...",
  "sid": "ses_abc...",
  "iat": 1710496200,
  "exp": 1710497100
}
```

| Field | Description |
|-------|-------------|
| `pid` | Project ID (resolved from the API key) |
| `wid` | Workspace ID (resolved from the API key) |
| `tid` | Trace ID (from the request body) |
| `sid` | Session ID (from the request body). Widget events use this as their `session_id`, sharing the server's session. |
| `iat` | Issued-at timestamp |
| `exp` | Expiry timestamp (15 minutes after `iat`) |

**Signing:** HMAC-SHA256 using the ingestion API's internal `JWT_SECRET` environment variable. This secret is configured in the deployment (Docker Compose / Yavio Cloud) and never exposed to SDKs.

**Error Responses:**
| Status | Condition |
|--------|-----------|
| `401 Unauthorized` | Invalid or revoked API key |
| `400 Bad Request` | Missing or invalid `traceId` |
| `429 Too Many Requests` | Rate limited |

### 6.2.3 Ingestion Request Flow

```
Server SDK                          Widget SDK
  │                                    │
  │  POST /v1/events                   │  POST /v1/events
  │  Authorization: Bearer <apiKey>    │  Authorization: Bearer <widgetJwt>
  │                                    │
  ▼                                    ▼
Ingestion API
  ├─ 1. Auth: API key lookup OR JWT signature verification
  │      → resolve project_id + workspace_id
  ├─ 2. Rate limit check (per API key, per IP)
  ├─ 3. Schema validation (reject malformed events)
  ├─ 4. Event enrichment (add workspace_id, project_id, ingested_at)
  ├─ 5. PII stripping (all string fields)
  ├─ 6. Batch buffering (accumulate for efficient ClickHouse insert)
  └─ 7. ClickHouse batch write
```

**Error Responses:**

| Status | Condition |
|--------|-----------|
| `200 OK` | All events accepted |
| `207 Multi-Status` | Partial success — some events accepted, others rejected (body includes per-event errors) |
| `400 Bad Request` | All events failed schema validation, or empty/missing request body |
| `401 Unauthorized` | Missing, invalid, expired, or revoked credential |
| `413 Payload Too Large` | Batch exceeds maximum allowed size |
| `429 Too Many Requests` | Rate limit exceeded. Includes `Retry-After` header. |
| `503 Service Unavailable` | Backpressure — ClickHouse write buffer full. Includes `Retry-After` header. |

### 6.2.4 API Key Resolution (Server SDK Auth)

The ingestion API validates the API key against PostgreSQL on every request. To avoid per-request database queries, resolved keys are cached in memory with a short TTL:

| Setting | Value | Rationale |
|---------|-------|-----------|
| Cache backend | In-memory LRU | Lightweight, no external dependency |
| Cache TTL | 60 seconds | Balance between performance and key revocation latency |
| Cache size | 10,000 entries | Covers most deployments. LRU eviction for larger ones. |

On cache miss, the API queries PostgreSQL: `SELECT project_id, workspace_id FROM api_keys JOIN projects ... WHERE key_hash = SHA256(key) AND revoked_at IS NULL`.

### 6.2.5 JWT Verification (Widget SDK Auth)

For widget requests authenticated with a JWT:

1. **Decode & verify signature** using the internal `JWT_SECRET`
2. **Check expiry** — reject if `exp < now()`
3. **Extract claims** — `pid` (project_id), `wid` (workspace_id), `sid` (session_id)

JWT verification is purely cryptographic (no database query needed), making it faster than API key resolution for widget traffic.

### 6.2.6 Rate Limiting

| Scope | Limit | Rationale |
|-------|-------|-----------|
| Per API key | 1,000 events/second | Generous for legitimate use. Prevents abuse from leaked keys. |
| Per API key burst | 5,000 events | Allows short spikes (e.g., batch import) |
| Per IP (unauthenticated) | 10 requests/second | Protects against brute-force key scanning |

Rate limit state is stored in memory. Exceeded limits return `429 Too Many Requests` with `Retry-After` header.

### 6.2.7 ClickHouse Batch Writer

Events are not written to ClickHouse one-by-one. The ingestion API accumulates events from multiple incoming requests and flushes them to ClickHouse in batches:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Flush interval | 1 second | Low latency for live feed. ClickHouse handles 1/s inserts well. |
| Max batch size | 10,000 events | Triggers early flush if buffer fills |
| Insert method | `INSERT INTO events FORMAT JSONEachRow` | Native ClickHouse batch insert. Most efficient method. |
| Error handling | Retry failed batches up to 3 times with exponential backoff. Return 503 on persistent failure. | SDK-level retries provide recovery for transient ClickHouse outages. |

## 6.2.8 Event Field Size Limits

Individual event fields are validated against maximum size limits to prevent storage exhaustion attacks. Fields exceeding the limit are truncated (for string fields) or rejected (for structural violations).

| Field | Max Size | Behavior on Exceed |
|-------|----------|-------------------|
| `metadata` (JSON) | 10 KB | Truncate: serialize, truncate at 10 KB boundary, replace with `{"_truncated": true, "_original_size": <bytes>}` |
| `user_traits` (JSON) | 5 KB | Same truncation behavior as `metadata` |
| `error_message` | 2 KB | Truncate string at 2 KB, append `... [truncated]` |
| `event_name` | 256 chars | Reject event (event names should be short identifiers) |
| `input_keys` (JSON) | 5 KB | Truncate |
| `input_types` (JSON) | 5 KB | Truncate |
| `intent_signals` (JSON) | 2 KB | Truncate |
| `user_id` | 256 chars | Reject event |
| `trace_id` | 128 chars | Reject event |
| `session_id` | 128 chars | Reject event |
| Total event size | 50 KB | Reject event |
| Batch size | 500 KB | Reject batch with `413 Payload Too Large` |

**Implementation:** Size checks run during schema validation (step 3 in §6.2.3), before PII stripping and ClickHouse writes. Truncation is preferred over rejection for non-critical fields to avoid data loss.

## 6.3 PII Stripping Engine

The PII stripping engine runs in the **ingestion API** on every event before it reaches ClickHouse. It is ON by default and cannot be disabled in Community/Cloud Free tiers. Enterprise tier allows configuration.

| Pattern | Detection Method | Replacement |
|---------|-----------------|-------------|
| Email addresses | RFC 5322 regex | `[EMAIL_REDACTED]` |
| Credit card numbers | Luhn algorithm + format check (13–19 digits) | `[CC_REDACTED]` |
| SSN / Tax IDs | NNN-NN-NNNN pattern and variants | `[SSN_REDACTED]` |
| Phone numbers | International format detection (E.164 + common formats) | `[PHONE_REDACTED]` |
| Physical addresses | Heuristic: number + street name patterns | `[ADDRESS_REDACTED]` |

The engine scans all string fields in the event, including nested JSON in the `metadata` field. It targets identity data; business values (prices, cities, dates, quantities) are preserved.

> **Why server-side PII stripping?** Centralizing PII stripping in the ingestion API (instead of in each SDK) has three advantages: (1) single place to update detection patterns, (2) PII rules apply consistently regardless of SDK version, (3) easier to audit and prove GDPR compliance.

## 6.4 Pipeline Guarantees

| Guarantee | Mechanism |
|-----------|-----------|
| **At-least-once delivery** | SDK retries failed HTTP requests. Ingestion API uses ClickHouse's `ReplacingMergeTree` for idempotent inserts if events carry a unique ID. |
| **Ordering** | Events carry millisecond timestamps. ClickHouse sorts by `(project_id, event_type, timestamp)`. Within a batch, order is preserved. |
| **No data loss on ingestion restart** | Failed ClickHouse writes are retried with exponential backoff. SDK-level retries provide additional recovery for prolonged outages. |
| **No data loss on SDK shutdown** | Server SDK and Widget SDK do a synchronous final flush. |
| **Backpressure** | The batch writer buffer (§6.2.7) doubles as the backpressure buffer. Events accumulate when ClickHouse is slow. When the buffer exceeds 100,000 events, the API returns `503 Service Unavailable` and SDKs retry with exponential backoff. |

## 6.5 Widget Event Validation

### 6.5.1 Batch-Level Trace Validation (v1)

Every event in a widget JWT batch must have `traceId === tid` from the JWT claims. The ingestion API rejects the **entire batch** with `400 Bad Request` if any event has a mismatched `traceId`. This prevents a single widget JWT from being used to inject events into unrelated traces.

**Implementation:** After JWT verification extracts the `tid` claim, the schema validation step checks `event.trace_id === tid` for every event in the batch. This is a zero-cost check (string comparison) that runs before PII stripping and ClickHouse writes.

### 6.5.2 Future: Server-Side Trace Correlation (Post-V1)

Widget JWTs are already trace-scoped (the `tid` claim restricts events to a single trace). A future enhancement adds **server-side trace correlation** — the ingestion API validates that the trace referenced by a widget JWT actually exists as a server-side trace before accepting widget events.

#### Rationale

Even with short-lived, trace-scoped JWTs, an attacker who can trigger MCP tool calls can extract fresh tokens and send fabricated widget events. Server-side trace correlation raises the bar further: widget events are only accepted if there is a matching server-side `tool_call` event for that trace, proving the widget interaction originated from a real tool invocation.

#### Validation Flow

When a widget JWT is presented:

1. Extract `tid` (trace ID) and `pid` (project ID) from the JWT claims
2. Query ClickHouse (or a fast lookup cache): does a `tool_call` event exist with `trace_id = tid AND project_id = pid AND source = 'server'`?
3. If no server-side trace exists → reject with `403 Forbidden`
4. If the server-side trace is older than a configurable window (e.g., 30 minutes) → reject as stale

#### Implementation Considerations

- **Latency:** A ClickHouse query on every widget request adds latency. Mitigate with an in-memory cache of recently-seen trace IDs (populated from the server SDK event stream).
- **Race condition:** The widget might send its first event before the server SDK's `tool_call` event is flushed to ClickHouse. Mitigate with a short grace period (e.g., accept widget events for up to 30 seconds even without a matching server trace, then validate retroactively).
- **Per-trace event caps:** Limit widget events to a maximum count per trace (e.g., 200 events). A real widget interaction is bounded; unbounded event streams for a single trace indicate abuse.

## 6.6 Future: Dead-Letter Queue

> **Status:** Post-V1 enhancement. Not implemented in the initial release.

When the ClickHouse batch writer exhausts all retries, failed batches are currently dropped (SDKs will retry from their side). A future enhancement adds a **disk-based dead-letter queue** for persistent failure recovery:

- **Format:** NDJSON files written to a configurable directory (e.g., `/var/lib/yavio/dead-letter/`)
- **Replay:** Automatic replay on service restart, or manual replay via CLI command
- **Retention:** Dead-letter files older than 7 days are garbage-collected
- **Monitoring:** Exposes a `dead_letter_count` metric for alerting
