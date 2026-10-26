# Ingestion API Testing

## Test Categories

| Category | Framework | Scope | Priority |
|----------|-----------|-------|----------|
| Unit tests | Vitest | PII stripping engine, schema validation, event enrichment, JWT minting/verification, API key resolution | P0 — ship blocker |
| API tests | Vitest + supertest | POST /v1/events, POST /v1/widget-tokens, GET /health: auth, rate limiting, schema validation, CORS, batch processing | P0 — ship blocker |
| Integration tests | Vitest + ClickHouse testcontainer | Full pipeline: HTTP request → validation → PII strip → ClickHouse write → verify stored data | P0 — ship blocker |
| Load tests | k6 or autocannon | Sustained throughput at 1,000 events/s, burst handling, backpressure (503) behavior | P1 — pre-launch |

## Unit Tests

### PII Stripping Engine

| Test Case | Input | Expected Output |
|-----------|-------|-----------------|
| Email redaction | `"Contact alice@example.com"` | `"Contact [EMAIL_REDACTED]"` |
| Multiple emails | `"From a@b.com to c@d.com"` | `"From [EMAIL_REDACTED] to [EMAIL_REDACTED]"` |
| Credit card (Visa) | `"Card: 4111111111111111"` | `"Card: [CC_REDACTED]"` |
| Credit card (Amex) | `"Card: 378282246310005"` | `"Card: [CC_REDACTED]"` |
| SSN format | `"SSN: 123-45-6789"` | `"SSN: [SSN_REDACTED]"` |
| Phone (`+CC`, compact) | `"Call +14155552671"` | `"Call [PHONE_REDACTED]"` |
| Phone (formatted) | `"Call (415) 555-2671"` | `"Call [PHONE_REDACTED]"` |
| Phone (trunk 0, #182) | `"call 0171-1234567"` | `"call [PHONE_REDACTED]"` (not `0[PHONE_REDACTED]`) |
| Phone glued to a word | `"Tel5551234567"` | `"Tel[PHONE_REDACTED]"` |
| UUID (#182) | `"47e16ee3-3d22-430b-acb1-959114949231"` | unchanged (was `…-95[PHONE_REDACTED]`) |
| Hex id (#182) | `"deadbeef5551234567"`, `"b7ad6b7169203331"` | unchanged |
| Traceparent inside text (#182) | `"traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01, call 555-123-4567"` | the traceparent unchanged, `call [PHONE_REDACTED]` |
| Bare nine digits glued to a word (#182, A1) | `"order_123456789"` | unchanged |
| Address | `"Ship to 123 Main Street"` | `"Ship to [ADDRESS_REDACTED]"` |
| Nested metadata | `{ metadata: { user: "alice@test.com" } }` | `{ metadata: { user: "[EMAIL_REDACTED]" } }` |
| No PII (preserve) | `"Total: $42.99, qty: 3"` | `"Total: $42.99, qty: 3"` (unchanged) |
| Empty string | `""` | `""` |
| Non-string fields | `{ count: 42, active: true }` | `{ count: 42, active: true }` (unchanged) |

The string rules are `@yavio/shared/pii`: its tests hold the exact-output table per flavor (SDK and ingest), the seeded id corpus (200 000 UUIDs and traceparents per kind, none cut by the phone, card or SSN patterns), the SDK/ingest mirror check and the 100 KB ReDoS guard (#182). `PII_ID_CORPUS_SIZE=200000` runs every id kind at that size.

### Schema Validation

| Test Case | Expected Result |
|-----------|-----------------|
| Valid `tool_call` event with all required fields | Accept |
| Valid `widget_view` event | Accept |
| Missing required `eventType` field | Reject with descriptive error |
| Missing `timestamp` | Reject |
| Unknown `eventType` | Reject |
| Empty batch (0 events) | Reject with 400 |
| Oversized batch (> 500 KB) | Reject with 413 |
| More than 1,000 events (valid or not) | Reject with 400 and one cap error at `index: -1`; no event parsed (neither the batch schema nor the per-event fallback runs), none stored |
| Exactly 1,000 valid events | Accept |
| Body nested deeper than 64 levels (e.g. a tool's `input_schema`) | 400 `Body nests deeper than 64 levels`, refused on the raw text before `JSON.parse` |
| Validation decisions | Identical to the batch schema plus per-event fallback over a generated corpus; each event parsed once |
| More than 100 rejected events within the cap | 207/400 lists the first 100 errors; `rejected` counts all |
| Header-less `text/plain` body over 64 KiB | 413 `YAVIO-2111`, body not parsed |
| Header-less request that is not `text/plain` | 401 `YAVIO-2000`, body not parsed |
| `text/plain` request with an empty or blank `Authorization` header | 401, body not parsed |
| JSON body over 600,000 bytes | 413 `YAVIO-2111`, body not parsed; 500 KB–600,000 bytes keeps `Batch exceeds 500KB limit` |
| 60,000-byte beacon with a valid body token | 200 |
| Extra unknown fields | Accept (ignore extra fields) |
| Invalid `timestamp` format | Reject |

### Event Enrichment

| Test Case | Expected Result |
|-----------|-----------------|
| Event without `workspace_id` | `workspace_id` added from auth context |
| Event without `project_id` | `project_id` added from auth context |
| `ingested_at` not set by ingest | The enriched row carries no `ingested_at`; ClickHouse stamps it at insert from the column DEFAULT (`now64(3)`), so the live feed's `ingested_at` cursor is monotonic with visibility (#148 review round 5) |
| Existing fields not overwritten | SDK-provided `timestamp` preserved |

### JWT Minting & Verification

| Test Case | Expected Result |
|-----------|-----------------|
| Mint JWT with valid API key and traceId | Returns signed JWT with correct claims (`pid`, `wid`, `tid`, `iat`, `exp`) |
| JWT expires after 15 minutes | `exp - iat === 900` |
| Verify valid JWT | Passes, returns claims |
| Verify expired JWT | Reject with 401 |
| Verify JWT with tampered signature | Reject with 401 |
| Verify JWT signed with wrong secret | Reject with 401 |

### API Key Resolution

| Test Case | Expected Result |
|-----------|-----------------|
| Valid key resolves project + workspace | Correct `project_id` and `workspace_id` returned |
| Invalid key | Returns null / not found |
| Revoked key | Returns null / not found |
| Cache hit (within 60s TTL) | No database query, same result |
| Cache expiry (after 60s) | Fresh database query |

## API Tests

### `POST /v1/events` — Authentication

| Test Case | Expected Status |
|-----------|-----------------|
| Valid API key (`yav_...`) | 200 |
| Valid widget JWT | 200 |
| Missing `Authorization` header | 401 |
| Malformed Bearer token | 401 |
| Expired API key | 401 |
| Revoked API key | 401 |
| Expired widget JWT | 401 |

### `POST /v1/events` — Request Processing

| Test Case | Expected Status |
|-----------|-----------------|
| Valid batch of events | 200 |
| Single valid event | 200 |
| Partially valid batch (some events fail schema) | 207 Multi-Status (valid events accepted, invalid rejected) |
| All events fail schema validation | 400 |
| Empty request body | 400 |
| Empty events array | 400 |
| Oversized batch | 413 |
| Rate limit exceeded | 429 with `Retry-After` header |
| ClickHouse unavailable (backpressure) | 503 with `Retry-After` header |

### `POST /v1/events` — CORS

| Test Case | Expected Result |
|-----------|-----------------|
| Preflight `OPTIONS` request | 200 with `Access-Control-Allow-Origin`, `Access-Control-Allow-Headers` |
| Cross-origin POST from widget iframe | Accepted with CORS headers |
| Non-allowed origin | Rejected or no CORS headers |

### `POST /v1/widget-tokens`

| Test Case | Expected Status |
|-----------|-----------------|
| Valid API key + valid `traceId` | 200 with JWT in response |
| Missing `traceId` in body | 400 |
| `traceId` or `sessionId` over 128 characters, or not a string | 400 |
| Presented token with `tid` or `sid` over 128 characters | 401 |
| Invalid `traceId` format | 400 |
| Invalid API key | 401 |
| Revoked API key | 401 |
| Widget JWT used (not API key) | 401 (only API keys can mint tokens) |
| Rate limit exceeded | 429 |

### `GET /health`

| Test Case | Expected Status |
|-----------|-----------------|
| Service running, all dependencies up | 200 with `{ "status": "ok" }` |
| ClickHouse unreachable | 200 with `{ "status": "degraded", "clickhouse": "down" }` |
| PostgreSQL unreachable | 200 with `{ "status": "degraded", "postgres": "down" }` |

### Rate Limiting

| Test Case | Expected Result |
|-----------|-----------------|
| Requests within API key limit (≤ 1,000 events/s) | All accepted |
| Burst within allowance (≤ 5,000 events) | Accepted |
| Requests exceeding API key limit | 429 with `Retry-After` |
| Different API keys have independent limits | Key A at limit does not affect Key B |
| Widget-token events beyond the token's bucket (1,000 burst, 50/s) | 429 `YAVIO-2053` with `Retry-After`; normal widget batches (20 events) and a 200-event beacon pass |
| Widget tokens of different traces | Independent buckets; the bucket key has a fixed length |
| Batch over the cap | Charged 1,000 events: the cap's 400 while the bucket holds 1,000, else 429 |
| Widget request with few events and a large body | Charged one unit per KiB |
| With `TRUST_PROXY`: widget tokens from one client address (IPv6: one /64) | One shared bucket; other addresses unaffected; none without `TRUST_PROXY` |
| A project's widgets together beyond the ceiling | 429 `... for this project`, one warn log a minute; API key and other projects unaffected |
| Widget buckets | Charged all or none |
| Header-authenticated request whose bucket is short (with or without Content-Length) | 429 before the body is read |
| Arrival charge above the real one | Refunded on success; a request is charged once |
| With `TRUST_PROXY`: 50 simultaneous valid beacons from one address | All accepted; header-less requests beyond the beacon burst refused unread |
| Address buckets | IPv6 by /64, IPv4 per address |
| `RATE_LIMIT_*` variables | Read by loadConfig; a burst must be a whole number holding one full request (widget: at least 1,000; beacon: at least 1), a rate a positive number; anything else stops the start |
| With `TRUST_PROXY`: beacons of a token whose widget bucket is empty | The beacon burst (100) is read and refused 429; the rest are refused on arrival, unread |
| Widget request whose handler never runs | Settled to the KiB its parser read; 415 to one unit; a client gone mid-body, or a request past `REQUEST_TIMEOUT_MS` (408), to the KiB received |
| IPv4-mapped IPv6 addresses, any notation | Counted as their IPv4 address |
| With `TRUST_PROXY`: concurrent header-less requests beyond the auth-failure burst | 429 before parsing; beacons that authenticate are refunded |
| Without `TRUST_PROXY`: concurrent beacons from one address | Not charged on arrival; all accepted |
| Widget-token traffic | Never charged to the project's API-key bucket; API-key requests never charged to a widget bucket |
| Unauthenticated requests exceeding 10 req/s per IP | 429 |

## Integration Tests

### Full Pipeline

| Test Case | Verification |
|-----------|-------------|
| POST valid batch → ClickHouse | Query ClickHouse, verify all events present with correct fields |
| PII in event metadata → ClickHouse | Query ClickHouse, assert zero PII in stored data |
| Event enrichment fields | Verify `workspace_id`, `project_id` populated in ClickHouse, and `ingested_at` stamped by ClickHouse within seconds of the insert |
| Batch accumulation | Send multiple small requests, verify ClickHouse receives single batch insert |
| ClickHouse restart during writes | Verify events are retried and eventually written after recovery |

### Edge Cases

| Test Case | Expected Behavior |
|-----------|-------------------|
| UTF-8 characters in event fields | Preserved correctly in ClickHouse |
| Maximum field lengths | Accepted up to limit, truncated or rejected beyond |
| Concurrent requests from multiple API keys | Events correctly attributed to respective projects |
| Rapid sequential batches | No event loss, correct ordering within batches |
| An event a column cannot store, handed to the writer below the schema (−1 and `1e21` into UInt32, a fraction into UInt16), among valid events | The valid events are stored, the refused ones dropped with one warning (ids and error names, no values), the next flush goes through (`integration/insert-isolation.test.ts`) |
| Error codes | `ROW_ERROR_CODES`, `SERVER_ERROR_CODES` and `RESOURCE_ERROR_CODES` names match `errorCodeToName` on the server; ClickHouse names the first refused row (`(at row 25001)`) in a 30,000-row insert over 10 MiB |
| Numeric bounds | Each numeric field's column type matches its bound; the largest accepted values are stored as sent (Float32's largest, not `inf`); an out-of-range number is rejected per event (207) |
| A lone surrogate in a string field | Stored with U+FFFD in its place |
| A timestamp with 20 fractional digits, via the API | Stored in milliseconds in `events.timestamp` and `tool_registry.registered_at` |
| Batch writer, fake ClickHouse (`batch-writer.test.ts`) | Success: one insert of the batch as buffered, no ping. Refused rows: a named row isolated in four inserts and dropped in its flush; without names in halves, dropped when refused a second time, also in a flush that stored nothing; each part with a token of its own; the refusal kept when the budget runs out; at most 64 budgeted inserts, oldest set-apart rows first; set-apart rows capped. Server errors and an unreachable ClickHouse: the batch kept as it is, counted, never split; resource errors split after 5 flushes; unrecognised errors while ClickHouse answers: split, the row set apart with a backoff and logged. Shutdown: valid events behind refused rows written, flushing until the deadline while ClickHouse is down, accurate logs |
| Loads, 1 flush per second (`batch-writer.test.ts`) | A: 200 refused rows per flush alone; B: 500 refused ahead of 5 valid of another project; C: 9,000 valid and 20 refused of one project; D: 3,000 valid and 5 refused; E: 1,000 refused from one project for 150 flushes and 20 valid from another, then valid only; F: the tool registry writer after 1,000 refused rows; M1: one row with an unrecognised error every 5 flushes among 1,000 valid. Valid events stored in every flush, no backpressure, set-apart rows within the cap and settled afterwards |
| Numeric bounds per field kind (`@yavio/shared` `numeric-bounds.test.ts`, ingest `numeric-bounds.test.ts`) | UInt16/UInt32: −1, 2^n, 1e21 and fractions rejected; Float64: ±Infinity rejected, fractions, negatives and 1e21 accepted; Float32: beyond ±3.4028234663852886e38 rejected; every numeric schema field is in the table |

## Load Tests (P1)

| Scenario | Target |
|----------|--------|
| Sustained throughput | 1,000 events/s for 5 minutes with < 100ms p99 latency |
| Burst handling | 5,000-event burst accepted without errors |
| Backpressure | 503 returned when buffer exceeds threshold, recovery after drain |
| Memory stability | No memory leaks over 30-minute sustained load |
