# SDK Testing

## Test Categories

| Category | Framework | Scope | Priority |
|----------|-----------|-------|----------|
| Unit tests | Vitest | Event schema validation, platform detection, queue logic, HTTP transport | P0 — ship blocker |
| Integration tests | Vitest | `withYavio()` proxy → event queue → HTTP flush (mock ingestion API) | P0 — ship blocker |
| React SDK tests | Vitest + Testing Library | `useYavio()` hook behavior, event buffering, flush on teardown, auto-config detection | P1 — important |

## Key Test Scenarios

- **Proxy transparency:** Wrapped server behaves identically to unwrapped server from the AI platform's perspective. No tool call failures, no latency regression, no response mutation.
- **Queue reliability:** Events are never lost during normal operation. Buffer respects max size (oldest dropped, not newest). Final flush on shutdown delivers remaining events.
- **HTTP transport resilience:** Failed requests are retried with exponential backoff. Permanent failures (401) stop retrying. Transient failures (5xx, network) retry up to max attempts.
- **API key discovery:** `withYavio()` correctly reads from code options, env vars, and `.yaviorc.json` in priority order.
- **Widget config injection:** `window.__YAVIO__` is correctly injected with API key, endpoint, and traceId when a tool returns a widget response.
- **Identify behavior:** `.identify(userId, traits)` sets `user_id` on all subsequent events in the session. Calling with a different `userId` in the same session is ignored with a warning. Traits are merged on repeated calls. Events before `.identify()` have `user_id = null`.
