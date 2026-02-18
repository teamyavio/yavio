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
- Widget config injection (`window.__YAVIO__` with widget JWT + endpoint; calls `POST /v1/widget-tokens` to mint token; API key stays on server)
- Unit tests: queue logic, HTTP transport, platform detection, config discovery, `.identify()` behavior
- Integration tests: McpServer → withYavio() → tool call → HTTP → mock ingestion, `.identify()` → `user_id` on events
- **Milestone:** SDK sends events to running ingestion API. Events visible in ClickHouse. `.identify()` correctly sets `user_id`.

## Phase 6: React Widget SDK

- `useYavio()` hook with auto-config detection (`window.__YAVIO__`)
- `.identify()` support in widget context (same behavior as server-side)
- Event buffer + flush logic (direct to ingestion API)
- `navigator.sendBeacon` teardown handler
- HTTP transport with widget JWT auth (short-lived token from `window.__YAVIO__.token`)
- Auto-captured widget events (render, click, scroll, form, navigation, etc.)
- No-op fallback when config not found
- React SDK tests (including `.identify()` in widget context)
- **Milestone:** Widget events flow from browser iframe → ingestion API → ClickHouse → dashboard. `.identify()` works in both server and widget contexts.

## Phase 8: Polish & Ship — SDK Items

- tsup build configuration + dual CJS/ESM output
- package.json exports field + peer dependencies
- npm publish `@yavio/sdk`

## v2 Backlog

- **JWT key rotation:** Add support for rotating the `JWT_SECRET` used to sign widget JWTs. Rotation procedure: deploy new secret alongside old one, verify both during a transition window, then remove old secret. Prevents single-secret compromise from minting arbitrary widget tokens indefinitely.
- **Widget JWT refresh:** Token refresh mechanism for long-running widget sessions (>15 minutes). The widget SDK requests a fresh JWT before the current one expires, preventing silent event loss on long interactions.
