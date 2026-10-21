# Per-Request Servers and MCP SDK v2

**Status:** Implemented 2026-10-20 (#133), review fixes 2026-10-21 · **Packages:** sdk, shared (error code), docs · **Version:** @yavio/sdk 0.5.0 (new API `createYavio()`, peer dependencies changed, `wrap()` instruments tools registered before the wrap) · **Depends on:** [protocol-layer-status.md](./protocol-layer-status.md) (#77), [per-tool-capture.md](./per-tool-capture.md) (#74)

## Problem

`withYavio()` assumed a long-lived MCP SDK v1 `McpServer`. Two kinds of setup broke that assumption.

**MCP SDK v2.** It is not `@modelcontextprotocol/sdk@2` (no such release) but a scoped package family: `@modelcontextprotocol/server` (`McpServer`, `Server`, `InMemoryTransport`, `createMcpHandler`), `core`, `node` (`NodeStreamableHTTPServerTransport`), `express`, `client`. Frameworks that moved to it (Skybridge 2) still depend on v1 as well, so the old peer range was satisfied and npm had nothing to warn about. Against v2 the 0.4.x wrap threw (`server.tool.bind` — v2 has no `tool()`), and behind that throw four more things were wrong: the low-level `setRequestHandler` takes a method **string**, so the protocol layer silently installed nothing (no `tool_discovery`, no validation events, no intent capture); the request `_meta` sits at `ctx.mcpReq._meta`, so sessions, locale and country were lost; an unknown or disabled tool is a **thrown** InvalidParams error, not an `isError` result; the 2026-07-28 protocol era carries the client identity per request in an envelope.

**Servers created per request.** Stateless hosts (the MCP SDK's stateless Streamable HTTP pattern, v2 `createMcpHandler`, `mcp-handler`, Skybridge 2) build a new `McpServer` for every request, so `withYavio()` could only run per request — and every call created a transport with its own flush timer, two process signal listeners, a filesystem walk for `.yaviorc.json`, the mode log lines, a private session store and a private widget-token cache. One transport and two listeners per request leak and soon trigger `MaxListenersExceededWarning`; `yavio.identify()` on request N was invisible on request N+1 of the same conversation. The hosted analytics MCP route in this repository runs on `mcp-handler` and was such an integrator.

## Decision

### Shared process-level state (`server/shared.ts`)

Everything that must survive across wraps lives in a module-level registry keyed by the resolved `(endpoint, apiKey)`:

| Shared per key | Per wrapped instance (`createProxy`) | Module level |
|---|---|---|
| the `HttpTransport` (one flush timer, one batch stream) | the connection's own session (calls without a session key) | `emittedConnections` — one `connection` per `(apiKey, session id)` |
| `sessions` — the LRU of conversation states (identify, traits, step sequence), keyed by the derived session id | the current MCP transport reference | `emittedToolDiscoveries` — one `tool_discovery` per `(apiKey, tool name)` |
| exactly one `SIGTERM`/`SIGINT` handler pair per process, draining every transport in the registry | `instrumentedTools` — the tools this instance wrapped | `proxiesByServer` — every proxy by the server it wraps and by itself (WeakMap), with the options it was built with, so a second wrap of the same server returns the first proxy |
| | the intent controller | `installedServers` — the low-level servers already patched; the warn-once sets |

**Not shared: the widget token.** Ingest binds a widget JWT's `tid` to the trace id of the call that minted it and rejects a widget batch under any other trace (`WIDGET_TRACE_ID_MISMATCH`), and every tool call has its own trace id. A token is therefore minted per call and never cached — neither across instances (the first version of #133 shared one, which broke every widget call after the first for ~14 minutes) nor across calls on one instance (0.4.x cached per proxy, which had the same effect on a long-lived server's second call). The issue's acceptance item "one mint across instances" was wrong.

**Lifetime.** A key's state is *held* by every `createYavio()` client bound to it (a counter) and *pinned* by the first `withYavio()` call for it. `client.shutdown()` flushes and releases that client's hold; the transport stops and the state is forgotten only when no client holds it and nothing pins it. A `withYavio()` state is never stopped before the process exits (that entry point has no shutdown), and the signal handlers drain everything. A `401` from ingest stops the transport for that key process-wide (`YAVIO-1203`): every wrap sharing the key stops delivering, which is what an invalid key means.

A hold names the transport's *generation*, so a hold on a transport a signal already drained releases nothing against its successor; a client whose hold is stale re-acquires on its next `wrap()`. Releasing a hold while others remain *drains* the transport (every queued batch, after any send in flight — `HttpTransport.drain()`), not just one flush; the drain is bounded by the transport's `shutdownTimeoutMs` (10 s) like `shutdown()`, and at the deadline it leaves the queue to the timer flush without stopping the transport. The key's state object (sessions, transport facade) outlives its transports: proxies keep it, and a re-acquire after a stop puts a fresh transport behind the same facade, so a re-wrap after the last holder's `shutdown()` — which returns the existing proxy — delivers through the new transport.

**After the signal.** The handler marks the process as draining before it drains the registry. A transport created from then on — by a wrap during the graceful-shutdown window, or by an existing proxy's next `send()` — is *immediate*: it sends on every `send()` (what queues during a send goes with the next one), has no timer and is drained by nobody; bounded by the fetch timeout and the buffer cap, and announced by one `[yavio] Shutdown signal received` line. `HttpTransport.shutdown()` first awaits the batch already in flight, within the same `shutdownTimeoutMs`.

`withYavio()` pins the state and creates it on first use; the mode log lines (`Server-only mode`, `Intent capture enabled`) and the no-key warning (`YAVIO-1000`) print once per process. The session LRU's eviction hook still drops the evicted session's connection-event mark (per key).

### `createYavio(options)` → `YavioClient { wrap(server), shutdown() }`

Resolves the configuration **once** (no filesystem walk per request) and holds the shared state. `wrap()` is synchronous and only does what `createProxy` does; it returns the server unchanged in no-op mode and for an unsupported value, and the existing proxy for a server that is already wrapped (or for a proxy itself) — a host that wraps its one long-lived server on every request must not stack a callback wrapper per request (N wraps gave N `tool_call` events per call in the first version). `shutdown()` drains and releases the client's hold (see Lifetime); a wrap after `shutdown()` holds the state again, or starts a fresh transport. **The first wrap wins:** a later wrap of the same server with any differing resolved option — endpoint, key, `capture`, `tools`, `serverOnly`, intent (compared as a stable-JSON fingerprint, `configFingerprint()`) — or a `wrap()` after a `withYavio()` (which would instrument the pre-registered tools), returns the existing proxy unchanged and logs `YAVIO-1108` once per process. `withYavio(server, options)` resolves per call, pins the state and wraps with the same guard — one `createProxy`, two entry points that differ in exactly one thing:

### Tools registered before the wrap — `wrap()` only

A stateless host builds the server — tools included — and wraps the finished server, so the `tool()`/`registerTool()` interceptors never see those registrations. `createYavio().wrap()` walks `_registeredTools` at wrap time and instruments every function-handler tool in place through `RegisteredTool.update({ callback })`, public API on every supported MCP SDK (v1 since the 1.24 floor, v2), with the same callback wrapper, capture flags and intent classification the interceptors apply. `update()` is the only way on v2, whose tools/call executor captured the handler at registration; it also sends `notifications/tools/list_changed` when the server is already connected — one per tool, harmless, and a per-request host wraps before it connects. Task tools (object handlers) stay out, as for the interceptors; a tool whose `update()` throws is skipped and not counted as instrumented, the rest still are.

`withYavio()` keeps the 0.4 behaviour exactly: a tool registered on the raw server before the wrap stays untracked. Integrations that keep a sensitive tool on the raw server on purpose ([per-tool-capture.md](./per-tool-capture.md) documents one) are unaffected on upgrade. Under either entry point a tool registered on the **unwrapped** server *after* wrapping is untracked, and the `tools` overrides are the supported way to limit capture for a sensitive tool — under `wrap()` the only way.

### MCP SDK v2 (`server/extra.ts`, `protocol.ts`, `proxy.ts`)

- The wrapped server is typed by shape — `McpServerLike` (`registerTool`, `connect` required; `tool`, `server` optional) — instead of v1's `McpServer`. The SDK has no runtime import of either MCP package; both are optional peers (`@modelcontextprotocol/sdk >=1.24.0`, `@modelcontextprotocol/server ^2.0.0`).
- `tool()` is bound and intercepted only when it exists.
- `requestMethod()` accepts a method string; the patched `setRequestHandler` wraps the last function argument in every form — `(schema, handler)`, `(method, handler)`, `(method, schemas, handler)`.
- One reader, `readCallExtra()`, maps both context shapes:

| What | MCP SDK v1 `RequestHandlerExtra` | MCP SDK v2 ctx |
|---|---|---|
| session id | `extra.sessionId` | `ctx.sessionId` |
| request `_meta` | `extra._meta` | `ctx.mcpReq._meta` |
| HTTP headers / URL | `extra.requestInfo.headers` (record), `.url` when a string (v1 transports pass a `URL` object, which is dropped) | `ctx.http.req` — a web `Request`: `headers` is a `Headers` object (lower-cased into a record); its `url` is **not read**, so v2 records what v1 records (a path can carry a secret as easily as the query string the sanitiser strips) |
| task id | `extra.taskId` | — |
| client identity | `server.server.getClientVersion()` (initialize handshake) | `ctx.mcpReq.envelope["io.modelcontextprotocol/clientInfo"]` on the 2026-07-28 era, then `getClientVersion()` |

- Status wrapper: a thrown InvalidParams whose text is exactly `Tool <name> not found` / `Tool <name> disabled` (v2) is counted as a `validation` event like v1's `isError` text — same table as [protocol-layer-status.md](./protocol-layer-status.md) — and re-thrown unchanged. A throw that arrives *with* the callback's event in hand came from above the handler (v2's wire validation of the result, `Invalid tools/call result: …`, reached when the protocol layer wraps a handler v2 already stored — tools registered before a `wrap()`): the event is corrected to `status: error`, `error_category: server`, like v1's output-schema failure; a URL elicitation passes through unchanged.
- The widget token's mint is started before the handler runs and awaited after it, so the round trip hides behind the handler; an unused mint (non-object result, handler threw) is dropped, which is why the mint resolves null on every failure (an endpoint that is not a URL included) and never rejects. `resolveConfig()` treats an empty or whitespace-only `endpoint` as unset (the default) and goes **no-op** for a non-empty value that is not an http(s) URL, with one `YAVIO-1002` error — never the hosted default, which would reroute a self-hosted integrator's events and key after a typo.
- The protocol wrappers go around the handler the MCP SDK *stored* (which carries its own request parsing and result validation), on the lazy registration path as on the in-place one, so a wire-rejected result reaches the status wrapper as a throw either way.
- The 2026-07-28 era is negotiated only over Streamable HTTP; `InMemoryTransport` negotiates 2025-11-25.

### Fail closed (`YAVIO-1107`)

A value without a `registerTool` and a `connect` function (the two methods the proxy binds) is returned unwrapped with one `console.error` per process, decided in `withYavio()` **before** the configuration is resolved — no transport, no listeners. `createYavio().wrap()` makes the same decision before it touches the shared state (so a `wrap(notAServer)` after `shutdown()` re-acquires nothing), and both entry points run it in no-op mode too.

## Changes

| Package | Change |
|---|---|
| sdk | `server/shared.ts` (new: registry with holds and pins, signal handlers, `logOnce`), `server/extra.ts` (new: `readCallExtra`), `server/index.ts` (`createYavio`, `withYavio`, the re-wrap guard, `YAVIO-1107`, warn-once `YAVIO-1000`), `server/proxy.ts` (shared sessions, per-call token mint, per-key dedup, optional `tool()`, opt-in pre-registered tool instrumentation, proxy registry, v2 thrown-InvalidParams rule, context reads through `extra.ts`), `server/protocol.ts` (string methods, last-argument wrapping), `core/types.ts` (`McpServerLike`, `YavioClient`), `package.json` (optional peers, v2 dev dependencies), `scripts/check-package.mjs` (a v2-only consumer), README. |
| shared | `ErrorCode.SDK.UNSUPPORTED_SERVER` (`YAVIO-1107`), `ErrorCode.SDK.REWRAP_OPTIONS_IGNORED` (`YAVIO-1108`). |
| docs | Setup and quickstart pages state both peers; error catalog row. |
| ci | `sdk-mcp-compat.yml` gains the `server-v2-floor` leg (the declared `^X.Y.Z` peer floor of `@modelcontextprotocol/server`, with `client` and `node` pinned to the same version) and the `server-v2` leg (latest `server` + `client` + `node`). |
| dashboard | **Follow-up, not in this change:** its `mcp-handler` route calls `withYavio()` per request and will share one transport once the dashboard's `@yavio/sdk` pin (`^0.3.0`, which the caret keeps below 0.5.0) is bumped to `^0.5.0` and the dashboard is deployed. Until then the route leaks as before. |

## Compatibility

- **Peer dependencies:** both MCP peers are optional. An app that installs neither gets no install-time warning and a `YAVIO-1107` at runtime if it passes something that is not an `McpServer`.
- **`withYavio()` behaviour is unchanged**, including for tools registered before the wrap. `createYavio().wrap()` is new and instruments those (see above). Release note.
- **Widget tokens are minted per tool call** in non-serverOnly mode (0.4.x cached one per proxy instance, see above): one `POST /v1/widget-tokens` per tool call that returns an object, bounded by a 2 s abort (`token.ts`), after which the result is returned without `_meta.yavio` and `YAVIO-1103` is logged once. `serverOnly: true` mints nothing. Release note.
- **Wrapping the same server twice** returns the existing proxy instead of instrumenting it twice; the second call's options are ignored (`YAVIO-1108` once when any of them differs).
- **Connection and discovery dedup are per API key**: two projects in one process each get their own `connection` and `tool_discovery` events.
- **`createYavio().shutdown()`** releases a hold; it stops the transport only when nothing else uses it.
- A client that sends neither `Mcp-Session-Id` nor `openai/session` to a per-request host gets one session per request — unchanged, and out of scope here (a `sessionKey(extra)` option is a follow-up).

## Tests

- `integration/mcp-v2.test.ts` — real `@modelcontextprotocol/server` + `client`: wrap without throwing; `_meta` from `mcpReq`, client meta, `openai/session`-derived session id; `tool_discovery` from `tools/list` once per tool; schema-rejected, unknown and disabled tool → `validation`; thrown handler → `unknown`; intent advertised and stripped; per-tool override; fluent `registerTool(config, cb)` chain; tracking calls carry the session. Over HTTP with `createMcpHandler` + `toNodeHandler`: negotiated version `2026-07-28`, one session across per-request instances, allowlisted headers only and no URL. The envelope read is tested on an instance that never saw a handshake (`getClientVersion()` empty): the connection event's client name comes from `mcpReq.envelope`.
- `integration/per-request.test.ts` — 1,000 wraps → one transport, one signal handler pair, no `MaxListenersExceededWarning`; `wrap()` synchronous and reusing `withYavio()`'s state; three instances → one stream, one `connection`, one `tool_discovery`, `identify()` carried across instances; two keys with the same tool name and conversation → two transports, no cross-delivery, one `tool_discovery` and one `connection` per key; a widget token per call, each bound to its own call's trace id; mode lines once per process; `shutdown()` then a fresh transport; `shutdown()` of one client leaves the other client's transport running; a client never stops a `withYavio()` transport; wrapping the same server four times (both entry points, and the proxy itself) → the same proxy and one `tool_call` per call; tools registered before the wrap: untracked under `withYavio()`, under `wrap()` success, schema rejection and unknown tool counted.
- `withYavio.test.ts` — the no-key warning once per process; an unsupported value adds no listener and no state.
- Review round 2: a hanging mint endpoint delays the result by the timeout at most and warns once (`per-request.test.ts`, `token.test.ts`); a wrap after the last holder's `shutdown()` delivers through the fresh transport, also via `withYavio()`; the first wrap wins with one `YAVIO-1108`; a non-last holder's `shutdown()` drains 250 queued events (`HttpTransport.drain()` unit tests too); after `shutdownAllShared()` two re-wrapping clients hold the new transport independently. `check-package.mjs` compiles the v2-only consumer with `skipLibCheck: false` and asserts no `@modelcontextprotocol` import in `dist/`.
- `proxy.test.ts` — a token per call, bound to the call's trace id (replaces the 0.4.x "reuses cached token" test).
- `integration/stateless-e2e.test.ts` — the README pattern with v1's stateless `StreamableHTTPServerTransport` over `node:http`: 50 calls from one conversation → 1 `connection`, 1 `tool_discovery` per tool, 1 `session_id`, 50 `tool_call`, batched.
- `withYavio.test.ts` — unsupported values (`{}`, `{ connect }`) come back unwrapped with one `YAVIO-1107` and no transport.
- `integration/intent.test.ts` — the pre-registered strict tool, wrapped with `instrumentExisting` (the `wrap()` path), yields one `tool_call` with its intent.
- `scripts/check-package.mjs` — a consumer with only `@modelcontextprotocol/server` installed (no v1) compiles against the packed typings.
