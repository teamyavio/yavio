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
| Phone (E.164) | `"Call +14155552671"` | `"Call [PHONE_REDACTED]"` |
| Phone (formatted) | `"Call (415) 555-2671"` | `"Call [PHONE_REDACTED]"` |
| Address | `"Ship to 123 Main Street"` | `"Ship to [ADDRESS_REDACTED]"` |
| Nested metadata | `{ metadata: { user: "alice@test.com" } }` | `{ metadata: { user: "[EMAIL_REDACTED]" } }` |
| No PII (preserve) | `"Total: $42.99, qty: 3"` | `"Total: $42.99, qty: 3"` (unchanged) |
| Empty string | `""` | `""` |
| Non-string fields | `{ count: 42, active: true }` | `{ count: 42, active: true }` (unchanged) |

### Schema Validation

| Test Case | Expected Result |
|-----------|-----------------|
| Valid `tool_call` event with all required fields | Accept |
| Valid `widget_view` event | Accept |
| Missing required `eventType` field | Reject with descriptive error |
| Missing `timestamp` | Reject |
| Unknown `eventType` | Reject |
| Empty batch (0 events) | Reject with 400 |
| Oversized batch (> max batch size) | Reject with 413 |
| Extra unknown fields | Accept (ignore extra fields) |
| Invalid `timestamp` format | Reject |

### Event Enrichment

| Test Case | Expected Result |
|-----------|-----------------|
| Event without `workspace_id` | `workspace_id` added from auth context |
| Event without `project_id` | `project_id` added from auth context |
| `ingested_at` timestamp added | Timestamp reflects server receive time |
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
| Unauthenticated requests exceeding 10 req/s per IP | 429 |

## Integration Tests

### Full Pipeline

| Test Case | Verification |
|-----------|-------------|
| POST valid batch → ClickHouse | Query ClickHouse, verify all events present with correct fields |
| PII in event metadata → ClickHouse | Query ClickHouse, assert zero PII in stored data |
| Event enrichment fields | Verify `workspace_id`, `project_id`, `ingested_at` populated in ClickHouse |
| Batch accumulation | Send multiple small requests, verify ClickHouse receives single batch insert |
| ClickHouse restart during writes | Verify events are retried and eventually written after recovery |

### Edge Cases

| Test Case | Expected Behavior |
|-----------|-------------------|
| UTF-8 characters in event fields | Preserved correctly in ClickHouse |
| Maximum field lengths | Accepted up to limit, truncated or rejected beyond |
| Concurrent requests from multiple API keys | Events correctly attributed to respective projects |
| Rapid sequential batches | No event loss, correct ordering within batches |

## Load Tests (P1)

| Scenario | Target |
|----------|--------|
| Sustained throughput | 1,000 events/s for 5 minutes with < 100ms p99 latency |
| Burst handling | 5,000-event burst accepted without errors |
| Backpressure | 503 returned when buffer exceeds threshold, recovery after drain |
| Memory stability | No memory leaks over 30-minute sustained load |
