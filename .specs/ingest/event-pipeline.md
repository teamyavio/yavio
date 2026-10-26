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
| Shutdown | Async drain on `SIGTERM`/`SIGINT` (every queued batch, 10 s bound), then the signal is handed back: the SDK removes its listeners and re-raises when it was the only one, see `.specs/sdk/server-sdk.md` (#138) | `navigator.sendBeacon()` on `visibilitychange` / unload |
| Retry | 5 retries, exponential backoff (1s–16s) | 3 retries, exponential backoff (1s–4s) |

### 6.1.2 SDK-Side Processing

Each event passes through these stages before entering the memory buffer:

1. **Enrichment:** Adds `timestamp`, `traceId`, `sessionId`, `userId` (if `.identify()` was called), `platform`, `sdkVersion`, `source` (server | widget) if not already present. The `sessionId` is always derived SDK-side: the server SDK derives it per tool call from the call's conversation key and labels it with `session_source` (see [server-sdk.md Section 3.7](../sdk/server-sdk.md#37-session-lifecycle)), and the widget SDK reads it from `window.__YAVIO__.sessionId` (the server's session ID, propagated via the widget JWT). Both server and widget events share the same `session_id`. The ingestion API never generates session IDs.
2. **Input/Output Capture:** For `tool_call` events, serializes the full input arguments and output content as JSON. Derives `inputKeys`, `inputTypes`, and `inputParamsCount` from the input object. Inspects output for size, content types, result count, and zero-result detection.
3. **Schema Validation:** Confirms event matches the expected shape. Malformed events are logged (server) or silently dropped (widget), never sent.
4. **Buffer Insertion:** Event added to in-memory array. If batch size threshold is met, flush is triggered immediately.

> **Note:** PII stripping uses a defense-in-depth strategy across two layers. The **SDK** runs a lightweight, non-configurable best-effort pass that strips common PII patterns (emails, credit cards, SSNs, phone numbers) from event payloads before they leave the process (`core/pii.ts`). This minimizes PII in transit and reduces exposure if the server-side layer has a bug. The **ingestion API** then strips every event again as the authoritative safety net before writing to ClickHouse, with the same rules (`@yavio/shared/pii`) plus spaced and bare SSNs, ITINs and US street addresses. It catches what the SDK does not strip, whatever the SDK version, but cannot restore what an older SDK already replaced. See [SDK Architecture — PII Strategy](../sdk/architecture.md#pii-strategy) for details.

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

`traceId` and `sessionId` must be strings of at most 128 characters, the limits of the `trace_id` and `session_id` event fields they must match (§6.2.8); otherwise `400` (`YAVIO-2300` / `YAVIO-2301`).
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
  ├─ 2. Rate limit check (per API key or widget token by event count, per IP)
  ├─ 3. Schema validation (reject malformed events)
  ├─ 4. Event enrichment (add workspace_id, project_id; ingested_at is the column DEFAULT, stamped by ClickHouse at insert — #148 review round 5)
  ├─ 5. PII stripping (all string fields)
  ├─ 6. Batch buffering (accumulate for efficient ClickHouse insert)
  └─ 7. ClickHouse batch write
```

**Error Responses:**

| Status | Condition |
|--------|-----------|
| `200 OK` | All events accepted |
| `207 Multi-Status` | Partial success — some events accepted, others rejected (body includes per-event errors, at most 100; `rejected` counts all) |
| `400 Bad Request` | All events failed schema validation, empty/missing request body, or more than 1,000 events in the batch (rejected whole before any event is validated, see §6.2.8) |
| `401 Unauthorized` | Missing, invalid, expired, or revoked credential |
| `408 Request Timeout` | The whole request did not arrive within `REQUEST_TIMEOUT_MS` (default 30 s); the connection is closed |
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
| Per widget token | 50 units/second | Bounds what one widget JWT sends over its 15 minutes. A widget sends at most 20 events per batch. |
| Per widget token burst | 1,000 units | One batch at the cap fits; a widget's teardown beacon (up to 200 events) fits many times over |
| Per client address, widget tokens (with `TRUST_PROXY`) | 200 units/second, burst 2,000 | All widget tokens used from one address (IPv6: one /64) together |
| Per project, widget tokens | 1,000 units/second, burst 10,000 | The ceiling for all of a project's widgets together; separate from the project's API-key bucket |
| Per IP (unauthenticated) | 10 requests/second | Protects against brute-force key scanning |
| Per address, header-less beacons on arrival (with `TRUST_PROXY`) | 50 requests/second, burst 100 | Bounds how many bodies one address has read before they authenticate; refunded when the beacon is accepted (status below 400) |

Every per-address bucket (credential-less, auth failures, beacons, widget address) is keyed by `addressBucket`: an IPv4 address as it is, an IPv6 address by its /64, an IPv4-mapped IPv6 address as its IPv4 address.

API keys are charged by event count (`events.length`, at most 1,000) before schema validation. Widget tokens are charged in **units**, `max(events, ceil(body bytes / 1 KiB))` with the same event count: what a request makes ingest read and parse, not only what it stores. A widget's batch (20 events, a few KB) and its beacon chunks (at most 200 events in 60,000 bytes) are charged by their events.

- **API key:** one bucket per project (`project_id:workspace_id`), shared by every key and server of the project.
- **Widget token:** one bucket per token, keyed by the JWT's `pid` and `tid` (the trace every event of the token must match, §6.5.1). Separate from the project's API-key bucket, so widget traffic never draws on the server-side budget.
- **Widget client address:** with `TRUST_PROXY` set, one bucket per client address across all widget tokens; an IPv6 address counts by its /64, an IPv4-mapped one as its IPv4 address. Without `TRUST_PROXY` there is no such bucket, since the address may be the proxy's for every client.
- **Widget project ceiling:** one bucket per project for all its widget tokens, separate from the API-key bucket. When it refuses, ingest logs `Widget rate limit for the project reached` (warn, with the project id) at most once a minute per project.
- **Before the body is parsed.** A request authenticated by its `Authorization` header is charged on arrival (route `onRequest`, `plugins/charge.ts`): an API key one event, a widget token `ceil(Content-Length / 1 KiB)` units on all of its widget buckets (Content-Length capped at the route's body limit for the type; without one, a chunked body, the JSON body limit: 586 units). If a bucket is short the answer is `429` and the body is not parsed. An error reply sent before any parser ran (`401`, `429` on arrival, `415`) carries `Connection: close`, so the rest of a declared body is not read to keep the connection alive; Fastify does the same for a body its parser refused (`413`, invalid JSON). The handler then settles the charge to the real one: more is charged when the real charge is higher (a refusal is a `429`, and the arrival charge stays, since the body was read); a widget token gets back what was charged above it. A request whose handler never runs keeps one event for an API key. A widget token is settled to the KiB its parser read (a body that fails to parse, or nests too deep); to one unit for an unsupported type (`415`, nothing parsed); otherwise (a chunked body over the limit) to the KiB of body the socket received, counted from the body bytes that came with the headers. A Content-Length over the limit is charged one unit on arrival, since it is refused `413` before it is parsed. A request whose client goes away mid-body, or whose body does not arrive within the request timeout (`408`, below), gets no response hook: an `onRequestAbort` hook settles it to the KiB of body the socket received.
- **Request timeout.** A client has `REQUEST_TIMEOUT_MS` (default 30,000) to send a whole request; then ingest answers `408` and closes the connection: Node detects the timeout, and Fastify's client-error handler writes the `408` with a JSON body (Fastify's default turns Node's own timeout off, so `createApp` sets it). Node checks every quarter of the timeout, and at least every 5 s.
- A widget request is charged to all of its buckets or to none, so a request refused on arrival costs nothing. The 429 is `YAVIO-2053` with the bucket in its message (`Widget token rate limit exceeded`, `... for this address`, `... for this project`) and `Retry-After` for the slowest bucket that is short.
- The charge is `min(events.length, 1000)` and comes before the batch cap (§6.2.8): a batch over the cap costs a full batch, so it gets the cap's `400` whenever its bucket holds 1,000 events, and `429` while the bucket is short.
- A widget token's bucket key is a SHA-256 of `pid:tid` (base64url), so its length does not depend on the claims. `tid` and `sid` are bounded anyway: at most 128 characters each at mint (§6.2.2) and when a token is presented (`401 YAVIO-2004` otherwise), like the `trace_id` and `session_id` they must match.
- **Header-less requests.** Only a widget beacon authenticates without an `Authorization` header: `text/plain`, widget token in the body's `token` field (#96), read up to 64 KiB (§6.2.8). Any other request without a header is refused `401` before its body is read; a header that is present but empty or blank counts as a header and gets `401` unread too. With `TRUST_PROXY` set, a header-less request is charged to its address's beacon bucket (50/s, burst 100) on arrival and refunded once it is accepted (a status below 400), so the number of bodies an address can have read before they authenticate is bounded. One that authenticates and is then refused (429 at its widget buckets, or 400) keeps the charge, since it was read; one that fails to authenticate is also charged to the auth-failure bucket, as before. Beacons are not retried, so the beacon bucket is separate from the auth-failure bucket's burst of 20: 50 simultaneous beacons from one NAT address pass. Without `TRUST_PROXY`, `request.ip` is the socket peer, which behind a proxy is the proxy for every client; header-less requests are then charged only when they fail to authenticate, after parsing, so normal beacons from many clients are not refused together. Without `TRUST_PROXY` the beacon path therefore has no per-address accounting: an authenticated beacon (at most 64 KiB) is bounded only by its token's and its project's widget buckets, and one refused there has been read.

The limits are the `RateLimiter` constructor's six arguments (API key, IP, widget token, widget address, widget project, beacon), each a partial `{ ratePerSecond, burstCapacity }` over the defaults above (`packages/ingest/src/lib/rate-limiter.ts`). The server takes the widget and beacon ones from the environment: `RATE_LIMIT_WIDGET_TOKEN_*`, `RATE_LIMIT_WIDGET_ADDRESS_*`, `RATE_LIMIT_WIDGET_PROJECT_*` and `RATE_LIMIT_BEACON_*`, each `_BURST` and `_PER_SECOND` (`config.ts`, documented in the self-hosting configuration page). Unset keeps the default. A burst must be a whole number that holds one full request: at least 1,000 for the widget buckets (`MIN_WIDGET_BURST`: a batch at the cap, and the 586-unit arrival charge of a JSON body without a Content-Length), at least 1 for the beacon bucket; a rate any positive number. Anything else stops the start with `INVALID_ENV_VAR`.

**The project ceiling is a trade-off.** About 20 widget tokens at their own limit (with `TRUST_PROXY`, from 5 or more addresses) reach a project's 1,000 units/s; from then on every widget of that project gets `429` until it refills. The ceiling bounds what one project's widget traffic costs the instance and its other tenants; the price is that a project's widget telemetry can be throttled by traffic sent with that project's tokens. Operators can raise it per deployment (`RATE_LIMIT_WIDGET_PROJECT_*`).

**TODO:** raise the per-address widget defaults to burst 5,000 and 500 units/s once the PII email matcher is linear (PR #198); until then they stay at 2,000 / 200.

Rate limit state is stored in memory. Exceeded limits return `429 Too Many Requests` with `Retry-After` header.

### 6.2.7 ClickHouse Batch Writer

Events are not written to ClickHouse one-by-one. The ingestion API accumulates events from multiple incoming requests and flushes them to ClickHouse in batches:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Flush interval | 1 second | Low latency for live feed. ClickHouse handles 1/s inserts well. |
| Max batch size | 10,000 events | Triggers early flush if buffer fills |
| Insert method | `INSERT INTO events FORMAT JSONEachRow` | Native ClickHouse batch insert. Most efficient method. |
| Error handling | By error (below): a server error or an unreachable ClickHouse keeps the batch, counted towards backpressure, and retries it as it is (3 attempts, 1 s and 2 s apart, per flush); an error about the rows splits the batch and sets the failing rows apart. Return 503 once the buffer and the batches kept after server errors reach 100,000 events; rows set apart never count. | SDK-level retries provide recovery for transient ClickHouse outages. |

**Failed inserts** (`lib/batch-writer.ts`). An event with a value outside its column's range (−1 or `1e+21` in a UInt32 column, a string with a lone surrogate escape, a timestamp with 20 fractional digits) does not fail the insert of the events buffered with it. A flush writes, in order: the batches kept after a server error; the rows set apart (oldest first, within the flush's isolation budget); the next batch. The error of a failed insert decides:

- **Row errors** (`ROW_ERROR_CODES`: `CANNOT_PARSE_*`, `TYPE_MISMATCH`, `INCORRECT_DATA`, `VALUE_IS_OUT_OF_RANGE_OF_DATA_TYPE`, `CANNOT_INSERT_NULL_IN_ORDINARY_COLUMN` and the like; matched by code, names checked against ClickHouse 26.8). The insert is not retried after a backoff. The batch is split: a batch of several projects in two — the project of the row ClickHouse names, split at that row at once, and all the other projects, inserted first and, failing again, split the same way; with no named row, the projects in two halves (`splitProjects`; at most 48 project-split inserts per flush outside the budget). A flush so needs two project-split inserts per project with refused rows — the others, and the named row alone (a row named wrongly, which ClickHouse then stores, costs no budgeted insert) — and one for its rows after the named row, however many clean projects the batch holds; and as the other projects go first, rows set apart when the budget runs out are those of projects with refused rows. Within one project the batch is split at the row ClickHouse names in its message, else in halves. Inserts are sent with `input_format_parallel_parsing=0`, so the named row is the first refused one — with parallel parsing ClickHouse can name a later one (not slower: a 10,000-row insert of 1 KB rows took a median 474 ms without, 490 ms with, on 26.8). The message quotes the input after the error position (`before: '…'`), so a row's own text can contain `(at row 1)`: the position read is the last `(at row N)` that ends a line, ClickHouse's own, after the quote. The rows before a named row parsed and are inserted at once, outside the budget; when they fail anyway they are split within it. The named row is inserted alone, and the rest after it. A single row ClickHouse refuses is set apart, and dropped when it is refused a second time — in the batch and alone, or alone twice — whether or not the flush stored anything. One warning per flush names the count, up to 5 event ids, the project ids and the error names, never a field value (`Dropped N events ClickHouse refused twice`); at error level when the flush stored nothing and the dropped rows come from more than one project, which may point at the table rather than the rows.
- **Server errors** (`SERVER_ERROR_CODES`: the connection, the table, access, space, load — too many parts or queries, no free connection, a task that cannot be scheduled, a lock that timed out), **any failure while ClickHouse does not answer a ping**, and — for up to 5 flushes in a row, counted apart: an outage in between starts the count again — **resource errors** (`RESOURCE_ERROR_CODES`: memory, time limits) and **errors without a ClickHouse code** (a client-side timeout: `@clickhouse/client` raises its request timeout as a plain `Error`; a reset connection): the batch is kept as it is (one batch, one deduplication token, migration 0014), counted towards backpressure, retried first in the next flush, and the failure ends the flush; the newer events wait in the buffer. Nothing is split or dropped. An insert that timed out may have been stored; its retry with the same token is dropped by the deduplication window, so it is stored once.
- **Any other failure while ClickHouse answers a ping** (an unlisted ClickHouse code; a resource or code-less error after 5 flushes; a row the row mapper cannot map): it is taken as specific to the batch, which is split like a row error. A single row that keeps failing is set apart — dropped only by the cap below — and retried after 1, 2, 4 … up to 64 flushes, with a warning naming its error. A batch split after 5 flushes of timeouts may have been stored by one of them; its parts carry new tokens, so those rows can be stored again — once per split level while the timeouts go on (up to 5–6 copies measured) — until a merge (or `FINAL`) collapses them.
- **Isolation budget.** A flush spends at most 64 inserts on sorting rows out: about two per row ClickHouse names (the row alone, the rest), the oldest set-apart rows first. Not counted: up to 48 project-split inserts, and the rows before a named row — once per part that was not itself such rows, so at most one per budgeted or split insert. What a flush cannot sort out is set apart for the next. One refused row among 10,000 takes four inserts in all. Every stored part is one block in the deduplication window of 1,000 blocks (migration 0014): at 65 inserts per flush the window covers about the last 15 flushes; at the most a flush can do — the batch, 64 budgeted inserts, 48 project splits and a free insert of the rows before a named row for each of those, about 225 — about the last 4.4; a part kept after a server error is retried in the next flush.
- **Rows set apart** never count towards backpressure, so they cannot make ingest refuse other events. They are capped at 1,000 rows per writer (`maxKeptRows`); beyond that rows are dropped with a warning (`Dropped N events kept apart after failed inserts: over the 1,000-event limit`), in this order (`rowsToDrop`): rows that failed on their own (refused once, or an unrecognised error); then the other rows of projects with such rows or with rows dropped in the flush; the rows of projects with none last. Within each, the project with the most of them first, its oldest first, so that one project's stream does not push out another's few. Valid events of a project that sends refused rows can be among the rows dropped. Clean projects' events are split off by the project splits above and are stored in their flush. Measured with a fake ClickHouse, one flush per second for 60 s: 1 project sending a refused row per flush among 30 to 300 clean projects, no clean event lost (three inserts per flush); 50 such projects among 100 clean ones, none lost (30 when ClickHouse names no row). With more projects sending refused rows per flush than a flush can split off (about 56 when rows are named: 48 free and 64 budgeted inserts, two per project), clean projects' rows are set apart unsorted for a later flush, and are dropped by the cap only after every row of the projects with refused rows: with 70 such projects, a fifth of the clean events was lost.
- **A table-level row error** (say, a column type that no longer matches after a migration) makes ClickHouse refuse every row: they are dropped as refused twice, or over the cap, each flush with a warning. A migration not yet applied that adds a column gives no error at all: ClickHouse stores the rows without the new field (`input_format_skip_unknown_fields`). Both are caught at startup instead: **ingest checks its schema** (`lib/schema-guard.ts`) — every column it writes (`EVENTS_COLUMNS` next to the enricher, `TOOL_REGISTRY_COLUMNS` next to the tool-registry mapper) must exist in ClickHouse with that exact type, read from `system.columns` as `yavio_ingest`; extra columns are fine. A missing column or another type logs the columns at fatal level and exits 1, so the deploy fails where it went wrong (migrate before ingest, `depends_on: migrate`). It waits up to 30 s for ClickHouse to answer. `INGEST_SKIP_SCHEMA_CHECK=1` skips the check, for an emergency only. The maps are kept in step with the schema (`event-enricher.test.ts`, `tool-registry.test.ts`) and with the migrations (`integration/startup-shutdown.test.ts`). `input_format_allow_errors_num`, which makes ClickHouse skip rows it cannot parse, was considered and not used: on such a table-level problem it would skip every row, silently, instead of keeping them, and it does not say which rows it skipped.
- **On success** a flush is one insert of the next batch, as before.
- **Shutdown.** On SIGTERM or SIGINT (`src/server.ts`) ingest stops taking requests (Fastify `close()`). `close()` waits for every open connection: a keep-alive connection that answered after the signal stays open, idle, and a request whose body is still arriving holds its connection. So from 2 s after the signal idle connections are closed every half second, and at 4 s all of them. Both writers then flush the buffered and kept batches until 14 s after the signal, then the rows set apart while a flush settles any of them; each logs what is left as not written by the deadline, and separately the rows set apart that were dropped. Ingest exits 0, or 1 when closing has not finished after 16 s, logging the events still held: buffered, set apart, and `in_flight` — in a flush still running, such as an insert ClickHouse has not answered. `docker-compose.yml` gives it `stop_grace_period: 20s` and runs it with `init: true`: the init passes signals on, ends Node on a signal that arrives before its handlers are registered (Node as PID 1 gets a signal only through a handler; without one Docker kills it after the grace period), and reaps child processes. Until this change ingest had no handler: the buffer was lost on every container stop.
- **Batches above 256 MiB.** ClickHouse squashes an insert into blocks of up to 1,048,449 rows or 256 MiB and refuses a block whole, so a refused batch below that has stored nothing. A larger batch can have its first blocks stored before a later row is refused; its parts then carry new deduplication tokens, so those rows are stored again until a merge (or `FINAL`) collapses them.
- The writers' warnings go to the ingest log with their details as fields (`lib/writer-logger.ts`); until this change they had no logger in production.

**Numeric fields are bounded by their columns** (`@yavio/shared/events`), so that such a value is rejected per event at validation (207, or 400 when no event is left) rather than reaching the writer. Integers beyond a UInt column's range are not refused by ClickHouse but wrap around (2^32 into a UInt32 is stored as 0), Float32 beyond its range becomes `inf`, and ±Infinity — what `JSON.parse` makes of `1e999` — was serialised as `null`; these are rejected too. Values the column stores as sent, such as a fraction or a negative in a Float64 column, stay accepted.

| Field | Event types | Column | Accepted |
|-------|-------------|--------|----------|
| `latency_ms` | `tool_call`, `sampling_call`, `elicitation` | `Nullable(Float64)` | finite |
| `connection_duration_ms` | `connection` | `Nullable(Float64)` | finite |
| `conversion_value` | `conversion` | `Nullable(Float64)` | finite |
| `visible_duration_ms` | `widget_visibility` | `Nullable(Float64)` | finite |
| `load_time_ms` | `widget_performance` | `Nullable(Float64)` | finite |
| `scroll_depth_pct` | `widget_scroll` | `Nullable(Float64)` | 0–100 (unchanged) |
| `device_pixel_ratio` | `widget_render` | `Nullable(Float32)` | ±3.4028234663852886e38 |
| `tokens_in`, `tokens_out` | `tool_call`, `sampling_call` | `Nullable(UInt32)` | integer, 0–4,294,967,295 |
| `step_sequence` | `step` | `Nullable(UInt32)` | integer, 0–4,294,967,295 |
| `click_count` | `widget_click` | `Nullable(UInt32)` | integer, 0–4,294,967,295 |
| `viewport_width`, `viewport_height` | `widget_render` | `Nullable(UInt16)` | integer, 0–65,535 |
| `is_retry` | `tool_call` | `UInt8` | integer, 0–1 (unchanged) |
| `device_touch` | `widget_render` | `Nullable(UInt8)` | integer, 0–1 (unchanged) |

String fields reach ClickHouse well-formed: the enricher puts U+FFFD in place of a lone UTF-16 surrogate (`event-enricher.ts`), which JSON allows and ClickHouse refuses in a String column. Timestamps reach it in milliseconds: the schema takes any number of fractional digits, ClickHouse's `DateTime64(3)` refuses 20 and more, and the normalizer writes every `timestamp` anew with `toISOString()` (`event-normalizer.ts`); `tool_registry.registered_at` is taken from it, and `updated_at` and `ingested_at` are stamped by ingest and ClickHouse.

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
| Request body, `application/json` | 600,000 bytes (`JSON_BODY_LIMIT`, `plugins/events.ts`) | `413` (`YAVIO-2111`) before the body is read in full. The 500 KB batch limit is checked on the parsed batch; this leaves room for formatting. |
| Request body, `text/plain` (widget beacon) | 64 KiB (`BEACON_BODY_LIMIT`): sendBeacon's own quota; the React SDK splits beacons at 60,000 bytes | `413` (`YAVIO-2111`) before the body is read in full. A header-less request is read only as `text/plain`, so this bounds what ingest reads before a request authenticates. |
| Body nesting | 64 levels of objects and arrays, the body being the first (`MAX_BODY_NESTING`, `lib/nesting.ts`) | Reject batch whole with `400` (`YAVIO-2100`, `Body nests deeper than 64 levels`, one error at `index: -1`, `rejected: 1`). Checked by the route's parsers on the raw text, one pass counting brackets outside strings, before `JSON.parse`; everything after them serializes or walks the parsed body by recursion. The PII walk replaces anything nested deeper than 64 levels with `[DEPTH_LIMIT]`; within the route it never gets that deep. |
| String fields without another limit | `platform`, `sdk_version`, `protocol_version` 64; `client_name` 256, `client_version` 128; `connection_type` 32; `field_name` 256; `nav_from`, `nav_to` 2,048 characters | Reject event (schema) |
| Events per batch | 1,000 (`MAX_BATCH_EVENTS`, `@yavio/shared/events`) | Reject batch whole with `400` (`YAVIO-2100`, message `Batch exceeds 1000 events`, one error at `index: -1`, `rejected` = events sent). Checked before any event is parsed: neither the batch schema nor the per-event fallback runs, and nothing is stored. |

**Implementation:** Size checks run during schema validation (step 3 in §6.2.3), before PII stripping and ClickHouse writes. Truncation is preferred over rejection for non-critical fields to avoid data loss.

**Per-event errors:** when the batch schema fails within the cap, each event is validated on its own, so valid events are still accepted (207). Each event is parsed once (the batch schema is not run first): the decisions are those of the batch schema. A 207 or 400 body lists at most 100 per-event errors (`MAX_REPORTED_ERRORS`), the first ones found, with at most 10 issues each (`MAX_ISSUES_PER_EVENT`); `rejected` counts every rejected event. The server SDK sends at most 100 events per batch, so it always gets every error.

## 6.3 PII Stripping Engine

The PII stripping engine runs in the **ingestion API** on every event before it reaches ClickHouse. It is ON by default and cannot be disabled in Community/Cloud Free tiers. Enterprise tier allows configuration.

The string-level rules live in `@yavio/shared/pii` (`stripPiiString(value, "ingest")`, #182), shared with the SDK's best-effort pass (flavor `"sdk"`: dashed SSNs only, no ITIN or address pattern); `lib/pii-stripper.ts` keeps the walk and the identifier-field exemption.

| Pattern | Detection Method | Replacement |
|---------|-----------------|-------------|
| Email addresses | `local@domain.tld` in ASCII, lengths bounded as in RFC 5321 (local part 64, domain 255, TLD 24). Matched from each `@` with the old regex's exact matches (review round 1): the regex scanned up to 64 characters at every position of a long run, 4.4 s per MB | `[EMAIL_REDACTED]` |
| IBANs | Compact or grouped in fours, ISO 13616 mod-97 check (#90); 0.03–0.09 % of 16–32-digit hex ids pass it (#191) | `[IBAN_REDACTED]` |
| Credit card numbers | 13–19 digits with optional space/dash separators, Luhn check, after any standalone word of letters too (review round 3); and exactly 16 digits in a row standing alone, Luhn or not (a mistyped card fails Luhn; review round 3). Missed: some 19-digit groupings, other spaces (no-break) as separators, a Luhn-invalid card in groups. Hit: Luhn-valid non-card numbers (ISBN, epoch ms) and any 16-digit run (epoch µs, order numbers) (#190) | `[CC_REDACTED]` |
| US SSNs | `NNN-NN-NNNN`, `NNN NN NNNN` (either separator may be missing) and the bare nine digits; area 000, 666 and 900–999 excluded. Only the fully separated form (`123-45-6789`, `123 45 6789`) uses the #182 boundary; the bare form and the forms with one separator keep `\b` boundaries (decision A1, review round 2), so `order_123456789` and `ABC123-456789` are not cut and `ssn_123456789` is not redacted | `[SSN_REDACTED]` |
| US ITINs | `9NN-NN-NNNN`, spaced or bare, with the SSN's boundaries per form | `[SSN_REDACTED]` |
| Phone numbers | An optional `+CC` or `00CC` (1–3 digits) and `(0)`, a first group of 3–4 digits or of 5 starting with a trunk 0 (`07141 1234567`, review round 3; optionally in parentheses), then 3 and 4 digits, each optionally separated by `-`, `.` or whitespace: the US formats and international numbers grouped like them (`+49 171 1234567`, `0171-1234567`, `(0171) 1234567`, `+49 (0)171 1234567`, `0049 171 1234567`); or a bare run of 12–15 digits not starting with 1 (decision A2). No E.164 parser: other groupings (`030 12345678`, `+33 6 12 34 56 78`, `0171 123 45 67`) and extensions are missed (#189); a standalone 10-digit number (epoch second, `ORD-2026-1234567890`) is hit (#192), and so is an EAN-13 | `[PHONE_REDACTED]` |
| Physical addresses | US: house number + capitalised street name + street suffix (+ optional unit) | `[ADDRESS_REDACTED]` |

Order: a string that is exactly a valid W3C traceparent is returned unchanged; email over the whole string; then UUID-shaped and traceparent-shaped tokens (any letter case, standing alone or right after an escape) are masked, and IBAN, card, SSN, ITIN and phone run on the text between them; address last, over the whole string. Card, SSN and ITIN (fully separated forms) and phone share one boundary rule (#182): the digit run may not touch a letter or digit on either side, except that it may follow an escape — URL `%XX`, double-encoded `%25XX` (review round 3), JSON `\uXXXX`, JSON `\b` `\f` `\n` `\r` `\t` (`%2B4917612345678`, review rounds 1 and 2) — a word of 1–24 letters only with a letter outside a–f, the word standing alone or right after an escape (`Tel5551234567`, `Call%20me%20at%20Tel5551234567`; `deadbeef5551234567` is not redacted), or such a word of letters a–f only when the number has a phone's shape: a `+`, a `(` or a separator after its first 2–4 digits or after a 5-digit group starting with 0 (`cafe555-123-4567`, `cafe07141 1234567`, review round 4). A card or IBAN candidate that began inside an escape (also right after the `%25` of a double-encoded one, review round 4) and fails its check is retried one character later (`Pay%20with%204111111111111111`: `204111…` fails Luhn, the card after the escape is then found; review round 2). A start inside an escape is not forbidden: the escape's digits are what catches `(890)%20567-5540` (as `%[SSN_REDACTED]`) and `50%555-123-4567`, so a phone number can take an escape's own digits with it (`%20` + `5551234567` → `%[PHONE_REDACTED]`; over-redaction, nothing of the number is left). A card (Luhn checked) may follow any standalone word of letters, a–f included (`cafe4367063062371650`, review round 3). Not redacted as the price of the boundary: a phone number glued to an a–f word without a phone's shape, a Luhn-invalid 16-digit run glued to one, and a number glued to a letters-and-digits token or to a word of more than 24 letters. A Luhn-valid card candidate that starts inside an escape wins over the card after it and leaves the last group (`"Card\u00204799 56605796 5730"` → `\u[CC_REDACTED] 5730`; `Card%3A%205555-5555-5555-4444` → `Card%3A%[CC_REDACTED]-4444`, as before #182). A bare nine-digit SSN/ITIN or one with a single separator right after a `\u00a0`-style escape is not redacted (A1); before #182 the phone pattern caught it through the escape's last digit. The lookbehind patterns are compiled on first use; an engine without lookbehind (the React widget on Safari and iOS before 16.4) gets the pre-#182 patterns instead. Before #182 the phone pattern had no leading boundary and cut the last ten decimal digits of hex runs (1.8 % of UUIDs, 0.9 % of hex ids, 1.9 % of traceparents inside text), and the card pattern took all-digit UUID segments.

The engine scans all string fields in the event, including nested JSON in the `metadata` field, except the identifier fields `event_id`, `trace_id`, `session_id`, `subject_id` and `timestamp` (#90): they hold no user content, and the phone pattern used to rewrite random ids that contained a digit run (the mask covers UUIDs since #182, the exemption every other id shape). It targets identity data; business values (prices, cities, dates, quantities) are preserved. Ingest cannot restore digits an SDK up to 0.5.5 replaced before sending (traits, metadata, error message, input values, output content, intent), and stored rows keep their tokens until the TTL; nothing is backfilled.

> **Why server-side PII stripping?** Centralizing PII stripping in the ingestion API (instead of in each SDK) has three advantages: (1) single place to update detection patterns, (2) PII rules apply consistently regardless of SDK version, (3) easier to audit and prove GDPR compliance.

## 6.4 Pipeline Guarantees

| Guarantee | Mechanism |
|-----------|-----------|
| **At-least-once delivery** | SDK retries failed HTTP requests. Ingestion API uses ClickHouse's `ReplacingMergeTree` for idempotent inserts if events carry a unique ID. |
| **Ordering** | Events carry millisecond timestamps. ClickHouse sorts by `(project_id, event_type, timestamp)`. Within a batch, order is preserved. |
| **No data loss on ingestion restart** | Failed ClickHouse writes are retried with exponential backoff. SDK-level retries provide additional recovery for prolonged outages. |
| **No data loss on SDK shutdown** | The server SDK drains on `SIGTERM`/`SIGINT` and on `client.shutdown()`, which resolves only once ingest answered (or at `shutdownTimeoutMs`), the signal's own drain included (#142); the widget SDK does a synchronous final flush. |
| **Once-only events are once per process** | `connection` is emitted at least once per session per SDK process (a stateless fleet: one per instance that served the conversation), `tool_discovery` once per tool per process. Ingest stores them as they come; the read side counts sessions as `uniqExact(session_id)` over every event — never connection rows — and reads `tool_registry` with `FINAL`, so duplicates change no number (#142). |
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

The batch writer keeps the rows of a failed insert in memory and retries them (§6.2.7); it drops rows ClickHouse refuses twice, rows set apart beyond its cap, and what is still unwritten at shutdown (14 s after the signal) or when the process ends. A future enhancement adds a **disk-based dead-letter queue** for persistent failure recovery:

- **Format:** NDJSON files written to a configurable directory (e.g., `/var/lib/yavio/dead-letter/`)
- **Replay:** Automatic replay on service restart, or manual replay via CLI command
- **Retention:** Dead-letter files older than 7 days are garbage-collected
- **Monitoring:** Exposes a `dead_letter_count` metric for alerting
