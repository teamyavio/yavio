# SDK Roadmap

## Phase 3: Server SDK HTTP Transport

- Event schema and TypeScript types (shared with ingestion API)
- Async batch queue (memory buffer → HTTP flush)
- HTTP transport with retry logic and exponential backoff
- `withYavio()` proxy implementation
- Context injection + AsyncLocalStorage
- Explicit API: `.identify()`, `.step()`, `.track()`, `.conversion()`
- `.identify()` behavior: sets `user_id` on session, merges traits, prevents `userId` change within session
- Platform detection module
- Config discovery: code options > env vars > `.yaviorc.json`
- Widget config injection: proxy injects `_meta.yavio` into every tool result (`{ token, endpoint, traceId, sessionId }`); calls `POST /v1/widget-tokens` to mint short-lived JWT; token cached with 30s expiry buffer, invalidated on reconnect and 401/403; API key stays on server. Legacy `window.__YAVIO__` injection also supported.
- Unit tests: queue logic, HTTP transport, platform detection, config discovery, `.identify()` behavior
- Integration tests: McpServer → withYavio() → tool call → HTTP → mock ingestion, `.identify()` → `user_id` on events
- **Milestone:** SDK sends events to running ingestion API. Events visible in ClickHouse. `.identify()` correctly sets `user_id`.

## Phase 6: React Widget SDK

> **Dependency note:** Phase 6 does not depend on Phase 5 (Dashboard Analytics Views). The widget SDK sends events to the ingestion API (Phase 2, done) and uses widget tokens minted by the server SDK (Phase 3, done). Phase 6 can proceed in parallel with Phase 5.

### Step 1: Package scaffold & build config

- Create `src/react/` directory: `index.ts`, `types.ts`, `config.ts`, `transport.ts`, `hook.ts`, `auto-capture.ts`
- Update `tsup.config.ts`: add `src/react/index.ts` as second entry, externalize `react` and `react-dom`
- Update `package.json`:
  - Add `"./react"` subpath export → `dist/react.{js,cjs,d.ts,d.cts}`
  - Add `react` ≥18 and `react-dom` ≥18 as optional peer deps (`peerDependenciesMeta.*.optional: true`)
- Verify dual build: `pnpm --filter @yavio/sdk build` produces both `dist/index.*` and `dist/react.*`
- Verify tree-shaking: React entry must not import server-side code (`AsyncLocalStorage`, MCP types)

### Step 2: Widget config types & detection

- `src/react/types.ts`:
  - `WidgetConfig { token: string, endpoint: string, traceId: string, sessionId: string }`
  - `YavioWidget` interface: `.identify(userId, traits?)`, `.step(name, meta?)`, `.track(event, props?)`, `.conversion(name, { value, currency, meta? })`
- `src/react/config.ts`: config resolution chain:
  1. `window.__YAVIO__` — primary (injected by server-side `withYavio()` proxy)
  2. `<meta name="yavio-config" content="...">` — JSON string fallback for non-standard setups
  3. `input._meta.yavio` or `input.yavio` — extracted from tool result metadata (raw MCP or Skybridge)
  4. Explicit `WidgetConfig` fields passed directly to `useYavio({ token, endpoint, traceId, sessionId })` — manual override
  5. `null` — no config found → triggers no-op mode
- `src/react/extract.ts`: standalone `extractWidgetConfig(input)` helper — checks `.yavio` and `._meta.yavio`, validates all 4 fields, returns `WidgetConfig | null`. Used internally by `resolveWidgetConfig()` and exported for direct use.
- Delete `window.__YAVIO__` after first read to reduce XSS exposure window
- Unit tests: detection from each source (including `_meta.yavio` and `.yavio`), priority chain, cleanup after read, null fallback, `extractWidgetConfig` standalone tests

### Step 3: Widget HTTP transport

- `src/react/transport.ts`: `WidgetTransport` class
- **Event buffer:** in-memory array, 5-second flush timer + 20-event early flush threshold (whichever first)
- **Offline tolerance:** max 200 buffered events; drop oldest on overflow
- **HTTP flush:** POST to `config.endpoint` with `Authorization: Bearer <config.token>` header
  - Request body: `{ events: [...], sdk_version, sent_at }` (same format as server SDK)
  - Each event includes `source: "widget"`, `trace_id`, `session_id` from config
- **Retry:** 3× exponential backoff (1s, 2s, 4s); halt immediately on 401 (expired/invalid JWT)
- **Teardown:** register `visibilitychange` listener (flush on `hidden`) + `pagehide`/`beforeunload` listener
  - Use `navigator.sendBeacon()` for final flush (respect ~64KB payload limit — split if needed)
  - Clean up all listeners on teardown
- Unit tests: buffer fill + flush timing, early flush at 20 events, overflow drop, retry with mock fetch, 401 stop, sendBeacon call on visibility change

### Step 4: `useYavio()` hook

- `src/react/hook.ts`: React hook implementation
- **Singleton pattern:** module-level instance — first `useYavio()` call initializes config detection + transport + auto-capture listeners; subsequent calls return same instance
- **Methods** (same signatures as server SDK):
  - `.identify(userId, traits?)` — sets `user_id` on all subsequent events, merges user traits
  - `.step(name, meta?)` — funnel step with auto-incrementing `step_sequence` per trace (widget-local counter)
  - `.track(event, props?)` — generic custom event
  - `.conversion(name, { value, currency, meta? })` — revenue attribution
- **Event construction:** `event_type`, `event_name`, `timestamp` (ISO), `trace_id`, `session_id`, `source: "widget"`, `viewport_width`, `viewport_height`, `metadata`
- **PII stripping:** reuse `core/pii.ts` regex-based redaction on metadata fields before buffering
- **No-op mode:** if config detection returns null, return inert `YavioWidget` that discards all calls silently (prevents crashes in dev/test)
- **Noop-to-active upgrade:** if `useYavio()` initially returned a no-op widget (no config) and is later called with valid config (e.g., tool result with `_meta.yavio`), it tears down the no-op instance and creates a real transport-backed widget. Derived from existing state (`state !== null && cachedConfig === null`) — no extra flag needed.
- `useYavio()` signature accepts `Partial<WidgetConfig> | Record<string, unknown>` to support passing raw tool results directly
- Unit tests: singleton behavior (multiple calls → same instance), all four methods, event shape validation, PII stripping, step_sequence auto-increment, no-op mode, noop-to-active upgrade

### Step 5: Auto-captured widget events

- `src/react/auto-capture.ts`: initialize listeners on first hook call, teardown on page unload
- All auto-captured events include `event_type: "auto"`, `source: "widget"`, `trace_id`, `session_id` from config
- **Events to capture:**

| Event | Trigger | Key fields |
|-------|---------|------------|
| `widget_render` | Once on init | `viewport_width`, `viewport_height`, `device_pixel_ratio`, `touch_support`, `connection_type`, `timezone` |
| `widget_error` | `window.onerror` + `unhandledrejection` | `error_message`, `error_stack` (truncated 1KB), `error_source` |
| `widget_click` | Click/tap listener | `target_tag`, `target_id`, `target_class`, `click_x`, `click_y`, `click_count` |
| `widget_scroll` | Throttled scroll (250ms) | `scroll_depth_pct`, `scroll_direction`, `viewport_height` |
| `widget_form_field` | Focus/blur on `<input>`, `<textarea>`, `<select>` | `field_name`, `field_type`, `time_in_field_ms`, `filled` |
| `widget_form_submit` | Form submit event | `form_id`, `success`, `validation_errors`, `time_to_submit_ms` |
| `widget_link_click` | Anchor element click | `href`, `link_text`, `is_external` |
| `widget_navigation` | `popstate` + History API intercept | `from_view`, `to_view`, `time_on_prev_ms` |
| `widget_focus` | `focus`/`blur` on iframe | `focus_duration_ms`, `focus_count` |
| `widget_visibility` | IntersectionObserver | `visible_duration_ms`, `percent_visible` |
| `widget_performance` | PerformanceObserver (navigation) | `load_time_ms`, `ttfp_ms`, `dcl_ms`, `resource_transfer_bytes` |
| `widget_rage_click` | 3+ clicks within 500ms on same element | `target_tag`, `target_id`, `click_count` |

- Graceful feature detection: skip listeners for unsupported APIs (e.g., IntersectionObserver, PerformanceObserver) — never throw in older browsers
- Unit tests per event type with mock DOM/window APIs (jsdom)

### Step 6: Public API export

- `src/react/index.ts`:
  - Named exports: `useYavio` hook, `extractWidgetConfig` helper
  - Type exports: `WidgetConfig`, `YavioWidget`
  - No default export (matches project convention)
- Verify import path works: `import { useYavio } from "@yavio/sdk/react"`
- Verify no server-side imports leak into React bundle (no `node:` builtins, no `AsyncLocalStorage`, no MCP types)

### Step 7: Tests

- Add `jsdom` environment to vitest config for `src/react/**` test files
- Add `@testing-library/react` (or `@testing-library/react-hooks`) as dev dependency for hook testing
- **Test suites:**
  - `__tests__/react/config.test.ts` — config detection from all sources, priority, cleanup, null fallback
  - `__tests__/react/transport.test.ts` — buffer, flush timing, retry, 401 handling, sendBeacon, overflow
  - `__tests__/react/hook.test.ts` — singleton, methods, event shape, PII strip, no-op
  - `__tests__/react/auto-capture.test.ts` — each of the 12 auto-captured events with mock DOM
  - `__tests__/react/integration.test.ts` — mock `window.__YAVIO__` → `useYavio()` → trigger events → assert HTTP requests to mock server
- Target: all tests pass in CI with jsdom environment

### Step 8: CI integration

- Update `dorny/paths-filter` in `ci.yml`: widget changes detected via existing `sdk` filter (code lives in `packages/sdk/src/react/`)
- Widget tests run as part of existing `test-sdk` job (same `@yavio/sdk` package — no new CI job needed)
- Verify `pnpm turbo run build typecheck lint test` passes with both server + react entry points
- Verify build output includes `dist/react.*` alongside `dist/index.*`

### Milestone

`useYavio()` hook works in browser context with zero configuration. Widget events (12 auto-captured types + 4 explicit methods) flow from browser iframe → HTTP POST with JWT auth → ingestion API → ClickHouse. `navigator.sendBeacon` ensures teardown delivery. `.identify()` works in both server and widget contexts. No-op mode prevents crashes when `window.__YAVIO__` is absent. CI green: `pnpm turbo run build typecheck lint test`.

## Phase 8: Polish & Ship — SDK Items

- tsup build configuration + dual CJS/ESM output
- package.json exports field + peer dependencies
- npm publish `@yavio/sdk`

## v2 Backlog

- **JWT key rotation:** Add support for rotating the `JWT_SECRET` used to sign widget JWTs. Rotation procedure: deploy new secret alongside old one, verify both during a transition window, then remove old secret. Prevents single-secret compromise from minting arbitrary widget tokens indefinitely.
- **Widget JWT refresh:** Token refresh mechanism for long-running widget sessions (>15 minutes). The widget SDK requests a fresh JWT before the current one expires, preventing silent event loss on long interactions.
