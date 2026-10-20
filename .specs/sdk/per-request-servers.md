# Per-Request Servers and MCP SDK v2

**Status:** Implemented 2026-10-20 (#133) · **Packages:** sdk, shared (error code), docs · **Version:** @yavio/sdk 0.5.0 (new API `createYavio()`, peer dependencies changed, tools registered before the wrap are now instrumented) · **Depends on:** [protocol-layer-status.md](./protocol-layer-status.md) (#77), [per-tool-capture.md](./per-tool-capture.md) (#74)

## Problem

`withYavio()` assumed a long-lived MCP SDK v1 `McpServer`. Two kinds of setup broke that assumption.

**MCP SDK v2.** It is not `@modelcontextprotocol/sdk@2` (no such release) but a scoped package family: `@modelcontextprotocol/server` (`McpServer`, `Server`, `InMemoryTransport`, `createMcpHandler`), `core`, `node` (`NodeStreamableHTTPServerTransport`), `express`, `client`. Frameworks that moved to it (Skybridge 2) still depend on v1 as well, so the old peer range was satisfied and npm had nothing to warn about. Against v2 the 0.4.x wrap threw (`server.tool.bind` — v2 has no `tool()`), and behind that throw four more things were wrong: the low-level `setRequestHandler` takes a method **string**, so the protocol layer silently installed nothing (no `tool_discovery`, no validation events, no intent capture); the request `_meta` sits at `ctx.mcpReq._meta`, so sessions, locale and country were lost; an unknown or disabled tool is a **thrown** InvalidParams error, not an `isError` result; the 2026-07-28 protocol era carries the client identity per request in an envelope.

**Servers created per request.** Stateless hosts (the MCP SDK's stateless Streamable HTTP pattern, v2 `createMcpHandler`, `mcp-handler`, Skybridge 2) build a new `McpServer` for every request, so `withYavio()` could only run per request — and every call created a transport with its own flush timer, two process signal listeners, a filesystem walk for `.yaviorc.json`, the mode log lines, a private session store and a private widget-token cache. One transport and two listeners per request leak and soon trigger `MaxListenersExceededWarning`; `yavio.identify()` on request N was invisible on request N+1 of the same conversation. The hosted analytics MCP route in this repository runs on `mcp-handler` and was such an integrator.

## Decision

### Shared process-level state (`server/shared.ts`)

Everything that must survive across wraps lives in a module-level registry keyed by the resolved `(endpoint, apiKey)`:

| Shared per key | Per wrapped instance (`createProxy`) | Module level, as before |
|---|---|---|
| the `HttpTransport` (one flush timer, one batch stream) | the connection's own session (calls without a session key) | `emittedConnections` — one `connection` per session id |
| `sessions` — the LRU of conversation states (identify, traits, step sequence), keyed by the derived session id | the current MCP transport reference | `emittedToolDiscoveries` — one `tool_discovery` per tool name |
| the widget-token cache (expiry decides re-mints; no longer reset on `connect()`) | `instrumentedTools` — the tools this instance wrapped | `installedServers` — the low-level servers already patched |
| exactly one `SIGTERM`/`SIGINT` handler pair per process, draining every transport in the registry | the intent controller | the warn-once sets |

`withYavio()` looks the state up and creates it on first use; the mode log lines (`Server-only mode`, `Intent capture enabled`) print once per process. The session LRU's eviction hook still drops the evicted session's connection-event mark.

### `createYavio(options)` → `YavioClient { wrap(server), shutdown() }`

Resolves the configuration **once** (no filesystem walk per request) and binds to the shared state. `wrap()` is synchronous and only does what `createProxy` does; it returns the server unchanged in no-op mode and for an unsupported value. `shutdown()` drains the transport and forgets the state, so a later wrap starts afresh. `withYavio(server, options)` is `createYavio(options).wrap(server)` — one implementation, two entry points.

### Tools registered before the wrap

A stateless host builds the server — tools included — and wraps the finished server, so the `tool()`/`registerTool()` interceptors never see those registrations. At wrap time the proxy walks `_registeredTools` and instruments every function-handler tool in place through `RegisteredTool.update({ callback })`, public API on every supported MCP SDK (v1 since the 1.24 floor, v2), with the same callback wrapper, capture flags and intent classification the interceptors apply. Task tools (object handlers) stay out, as for the interceptors.

This changes one documented behaviour: before #133, a tool registered on the raw server *before* `withYavio()` stayed untracked. It is now instrumented. A tool registered on the **unwrapped** server *after* wrapping is still untracked, and the `tools` overrides remain the way to limit capture for a sensitive tool.

### MCP SDK v2 (`server/extra.ts`, `protocol.ts`, `proxy.ts`)

- The wrapped server is typed by shape — `McpServerLike` (`registerTool`, `connect` required; `tool`, `server` optional) — instead of v1's `McpServer`. The SDK has no runtime import of either MCP package; both are optional peers (`@modelcontextprotocol/sdk >=1.24.0`, `@modelcontextprotocol/server ^2.0.0`).
- `tool()` is bound and intercepted only when it exists.
- `requestMethod()` accepts a method string; the patched `setRequestHandler` wraps the last function argument in every form — `(schema, handler)`, `(method, handler)`, `(method, schemas, handler)`.
- One reader, `readCallExtra()`, maps both context shapes:

| What | MCP SDK v1 `RequestHandlerExtra` | MCP SDK v2 ctx |
|---|---|---|
| session id | `extra.sessionId` | `ctx.sessionId` |
| request `_meta` | `extra._meta` | `ctx.mcpReq._meta` |
| HTTP headers / URL | `extra.requestInfo.headers` (record), `.url` | `ctx.http.req` — a web `Request`: `headers` is a `Headers` object (lower-cased into a record), `url` |
| task id | `extra.taskId` | — |
| client identity | `server.server.getClientVersion()` (initialize handshake) | `ctx.mcpReq.envelope["io.modelcontextprotocol/clientInfo"]` on the 2026-07-28 era, then `getClientVersion()` |

- Status wrapper: a thrown InvalidParams whose text is exactly `Tool <name> not found` / `Tool <name> disabled` (v2) is counted as a `validation` event like v1's `isError` text — same table as [protocol-layer-status.md](./protocol-layer-status.md) — and re-thrown unchanged.
- The 2026-07-28 era is negotiated only over Streamable HTTP; `InMemoryTransport` negotiates 2025-11-25.

### Fail closed (`YAVIO-1107`)

A value without a `registerTool` function is returned unwrapped with one `console.error` per process, decided in `withYavio()` **before** the configuration is resolved — no transport, no listeners.

## Changes

| Package | Change |
|---|---|
| sdk | `server/shared.ts` (new: registry, signal handlers, `logOnce`), `server/extra.ts` (new: `readCallExtra`), `server/index.ts` (`createYavio`, `withYavio` on top of it, `YAVIO-1107`), `server/proxy.ts` (shared sessions and token cache, optional `tool()`, pre-registered tool instrumentation, v2 thrown-InvalidParams rule, context reads through `extra.ts`), `server/protocol.ts` (string methods, last-argument wrapping), `core/types.ts` (`McpServerLike`, `YavioClient`), `package.json` (optional peers, v2 dev dependencies), `scripts/check-package.mjs` (a v2-only consumer), README. |
| shared | `ErrorCode.SDK.UNSUPPORTED_SERVER` (`YAVIO-1107`). |
| docs | Setup and quickstart pages state both peers; error catalog row. |
| ci | `sdk-mcp-compat.yml` gains the `server-v2` leg (latest `@modelcontextprotocol/server` + `client` + `node`). |
| dashboard | None required: its `mcp-handler` route calls `withYavio()` per request and now shares one transport without a code change. |

## Compatibility

- **Peer dependencies:** both MCP peers are optional. An app that installs neither gets no install-time warning and a `YAVIO-1107` at runtime if it passes something that is not an `McpServer`.
- **Tools registered before the wrap** are now instrumented (see above). Release note.
- **Widget token cache** is no longer cleared on `connect()`; a token is reused until 30 s before its expiry across reconnects and instances.
- A client that sends neither `Mcp-Session-Id` nor `openai/session` to a per-request host gets one session per request — unchanged, and out of scope here (a `sessionKey(extra)` option is a follow-up).

## Tests

- `integration/mcp-v2.test.ts` — real `@modelcontextprotocol/server` + `client`: wrap without throwing; `_meta` from `mcpReq`, client meta, `openai/session`-derived session id; `tool_discovery` from `tools/list` once per tool; schema-rejected, unknown and disabled tool → `validation`; thrown handler → `unknown`; intent advertised and stripped; per-tool override; fluent `registerTool(config, cb)` chain; tracking calls carry the session. Over HTTP with `createMcpHandler` + `toNodeHandler`: negotiated version `2026-07-28`, one session across per-request instances, client name from the envelope, allowlisted headers only.
- `integration/per-request.test.ts` — 1,000 wraps → one transport, one signal handler pair, no `MaxListenersExceededWarning`; `wrap()` synchronous and reusing `withYavio()`'s state; three instances → one stream, one `connection`, one `tool_discovery`, `identify()` carried across instances; two keys → two transports, no cross-delivery; one widget-token mint across instances; mode lines once per process; `shutdown()` then a fresh transport.
- `integration/stateless-e2e.test.ts` — the README pattern with v1's stateless `StreamableHTTPServerTransport` over `node:http`: 50 calls from one conversation → 1 `connection`, 1 `tool_discovery` per tool, 1 `session_id`, 50 `tool_call`, batched.
- `withYavio.test.ts` — unsupported values (`{}`, `{ connect }`) come back unwrapped with one `YAVIO-1107` and no transport.
- `integration/intent.test.ts` — the pre-registered strict tool now yields one `tool_call` with its intent.
- `scripts/check-package.mjs` — a consumer with only `@modelcontextprotocol/server` installed (no v1) compiles against the packed typings.
