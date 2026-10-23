# @yavio/sdk

Instrument [MCP](https://modelcontextprotocol.io/) servers with analytics, session tracking, and an optional React widget — all in one line of code.

## Install

```bash
npm install @yavio/sdk
```

Works with either MCP SDK generation, installed as an optional peer dependency: `@modelcontextprotocol/sdk` >=1.24.0 (v1) or `@modelcontextprotocol/server` 2.x (v2, the scoped package family). CI tests the v1 floor, the latest v1 release, the v2 floor and the latest v2 release weekly.

## Quick Start

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withYavio, yavio } from "@yavio/sdk";

const server = withYavio(
  new McpServer({ name: "my-server", version: "1.0.0" }),
);

server.registerTool("search", { inputSchema: { query: z.string() } }, async ({ query }) => {
  yavio.identify("user-123");
  yavio.step("search");
  yavio.track("search_executed", { query });

  const results = await doSearch(query);
  return { content: [{ type: "text", text: JSON.stringify(results) }] };
});
```

Tool calls, inputs, outputs, and timing are captured automatically. Custom events are optional.

## Configuration

The SDK resolves config in order:

1. Options passed to `withYavio(server, options)`
2. Environment variables `YAVIO_API_KEY`, `YAVIO_ENDPOINT` (and `YAVIO_SERVER_ONLY`, `YAVIO_INTENT`, `YAVIO_SHUTDOWN_TIMEOUT_MS`)
3. `.yaviorc.json` (walks up from cwd)

If no API key is found, `withYavio()` returns the original server unchanged — zero overhead, no HTTP requests.

### Options

```typescript
withYavio(server, {
  apiKey: "yav_...",
  endpoint: "https://ingest.yavio.app",
  serverOnly: false,     // skip _meta.yavio injection + widget token mint (default: false)
  intent: false,         // capture the agent's stated intent per tool call (default: false)
  capture: {
    inputValues: true,   // capture tool input values + client metadata (default: true)
    outputValues: true,  // capture tool output values (default: true)
    geo: true,           // location: true | "region" | "country" | false (default: true), see below
    rejectedInputValues: false, // argument values of calls the schema rejected (default: false), see below
    tokens: true,        // reserved — no effect today
    retries: true,       // reserved — no effect today (is_retry is never set)
  },
  tools: {               // per-tool overrides of the capture flags (default: none)
    "book-contract": { inputValues: false, outputValues: false, intent: false },
  },
  shutdownTimeoutMs: 4_000, // deadline for delivering queued events on shutdown: an integer in [100, 2147483647] ms (default: 4 s); on SIGTERM/SIGINT one deadline for the whole process, the smallest value set explicitly, see Stateless
  sessionKey: ({ headers }) => headers["x-conversation-id"], // the conversation of a call that carries no session key the SDK knows (default: none; code only), see Stateless
});
```

`capture` and `tools` can also be set in `.yaviorc.json`. What each flag controls is listed under [Captured data](#captured-data).

### Per-tool overrides

Some tools take data that must never reach analytics — a booking tool with an IBAN, a support tool with a message body. Turning `capture.inputValues` off globally would lose input capture for every tool, and registering the tool on the unwrapped server loses more than that: no `tool_call` event (latency, status, intent) **and** `yavio.conversion()` / `track()` / `step()` / `identify()` become no-ops for it, because they only have a session and trace to attach to inside a wrapped call.

`tools` keeps such a tool on the instrumented server while the SDK guarantees what is not captured for it:

```typescript
withYavio(server, {
  capture: { inputValues: true, outputValues: true },
  tools: {
    "book-contract": { inputValues: false, outputValues: false, intent: false },
  },
});
```

| Override | `false` means |
|----------|---------------|
| `inputValues` | No `input_keys`, `input_types`, `input_values`, no client metadata (`locale`, `country_code`, `end_user_agent`, `subject_id`) and no thrown error's message for this tool, on success and on error |
| `outputValues` | No `output_content`, and no `error_message` taken from an `isError` result (that text is output). `status` and `error_category` are still recorded; a thrown error's message is (it is gated on `inputValues`, see below) |
| `intent` | The `context` parameter is neither advertised nor captured for this tool. A `context` a client still sends from a cached schema is stripped before validation, so strict schemas keep accepting the call. No effect while intent capture is off globally |
| `rejectedInputValues` | A call to this tool that is rejected before the handler runs stores no argument values, no invented key names and only a value-free reason. `true` keeps the raw arguments and McpServer's error text. Same as the global flag (below) |

A key that is omitted inherits the global value, so an override can also switch a flag *on* for one tool. Names are not validated — tools register after `withYavio()` runs — so an override for a tool that never registers is simply unused. The tool still emits `tool_discovery` (description and schema, no user data) and `tool_call` with latency and status, and tracking calls from inside its handler carry the full session context.

### Intent capture

With `intent: true`, every tool advertises a required `context` parameter so the calling model states the user's goal on each call. The value is captured as the call's intent, stripped before your handler runs, and shown on the tool detail page in the dashboard. Tool code, schemas, and calls without `context` are unaffected; tools that define their own `context` parameter are left alone.

Intent text is derived from the end user's conversation — disclose the collection in your privacy policy, and review the ChatGPT App Store / Claude Directory data-collection policies before enabling it for a listed app. See the [intent capture docs](https://docs.yavio.ai/docs/02-sdk/07-intent-capture) for details.

### Server-only mode

Pass `serverOnly: true` (or set `YAVIO_SERVER_ONLY=1`) when you only want server-side event capture and your tool responses must remain byte-identical to what your handler returns:

```typescript
withYavio(server, { apiKey: "yav_...", serverOnly: true });
```

In this mode the SDK:

- does **not** inject `_meta.yavio` into tool results,
- does **not** mint a widget token (no extra HTTP round-trip on the first tool call),
- still emits `tool_discovery`, `tool_call`, and `connection` events,
- still supports the full `yavio.identify / step / track / conversion` API inside handlers.

The React widget (`useYavio()`) auto-configures from `_meta.yavio`, so it will not connect on its own in server-only mode — pass config to the hook explicitly if you still want client-side tracking.

### Stateless / per-request servers

Stateless HTTP hosts build a new `McpServer` for every request (the MCP SDK's stateless Streamable HTTP pattern, v2 `createMcpHandler`, `mcp-handler`, Skybridge 2). Create the client once per process and wrap each server as it is built:

```typescript
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createYavio } from "@yavio/sdk";

// Once per process: config, the HTTP transport to ingest, the shutdown hooks.
// (Named `analytics` here: `yavio` is the package's tracking singleton.)
const analytics = createYavio({ serverOnly: true, capture: { geo: "country" } });

function buildServer() {
  const server = new McpServer({ name: "example", version: "1.0.0" });
  server.registerTool("get_price", { /* schemas, annotations, _meta */ }, handler);
  return server;
}

const app = express().use(express.json());
app.post("/mcp", async (req, res) => {
  // Per request: cheap and synchronous, no new transport, listeners or session store.
  const server = analytics.wrap(buildServer());
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
```

On MCP SDK v2 only the imports differ: `McpServer` from `@modelcontextprotocol/server`, `NodeStreamableHTTPServerTransport` from `@modelcontextprotocol/node`, or `createMcpHandler((ctx) => analytics.wrap(buildServer()))`.

What holds across instances **and across processes** (a fleet behind a load balancer, where any instance serves any request): the same `session_id` for the same conversation (any key in the table below), and the client identity on the `connection` event even though the instance serving `tools/call` never saw `initialize` (see [Captured data](#captured-data)). What is **per process**: `yavio.identify()` on one request is visible on the next only when the same process serves it, and each process sends its `identify` event once per session (again only when a trait changes; since 0.5.4) (the dashboard and the statistics count every event of the conversation for its first identified user across processes, #145, and ChatGPT users also by `openai/subject`); the step sequence restarts per process (funnels order a conversation's steps by time); the `connection` event is emitted at least once per session per process and `tool_discovery` once per tool per process, so a conversation served by six instances has six connection rows — nothing counts them (sessions are distinct `session_id`s everywhere, discovery rows collapse per tool). Widget tokens are minted per tool call in non-serverOnly mode, as the ingest contract requires (a token is bound to the trace of the call that minted it); the mint is bounded by a 2 s timeout, after which the result goes out without `_meta.yavio`.

**Sessions.** A per-request server has no session of its own: a stateless transport never issues `Mcp-Session-Id`, and the 2026-07-28 protocol era drops the header. The SDK takes a call's session from the first of these keys it finds, and every event says which in `session_source`:

| Order | Key | `session_source` |
|---|---|---|
| 1 | `Mcp-Session-Id` (a sessionful transport) | `mcp_session_id` |
| 2 | ChatGPT's `_meta["openai/session"]` | `openai_session` |
| 3 | VS Code / Copilot Chat's `_meta["vscode.conversationId"]`, from any client | `vscode_conversation` |
| 4 | The Codex CLI's `_meta.threadId` — only from `codex-mcp-client` (named by its envelope, its `initialize` or its User-Agent): a bare `threadId` from another client is not trusted | `codex_thread` |
| 5 | Your `sessionKey` option | `custom` |
| — | None of them: the connection's own session — on an HTTP request that is one request, on stdio one client process | `per_request` / `connection` |

Keys 3 and 4 apply on stdio too, so since 0.5.4 a VS Code stdio server gets one session per conversation instead of one per client process — more sessions there, and `identify()` no longer carries from one conversation to the next. The other clients known today — Claude Code, claude.ai connectors, Cursor, Zed — send no conversation key; if your host knows the conversation (a header your gateway sets, a conversation id in your own auth layer), tell the SDK:

```typescript
const analytics = createYavio({
  serverOnly: true,
  sessionKey: ({ headers }) => headers["x-conversation-id"],
});
```

`sessionKey(request)` receives `{ headers, meta, authInfo, extra }` — the HTTP request's headers (names lower-cased, a repeated header's values joined with `", "`, `{}` off HTTP), the request `_meta` (`{}` without one), what your auth middleware set as `req.auth` (`undefined` without one) and the MCP SDK's own handler context — the same on MCP SDK v1 and v2. It is called only when none of keys 1–4 is there, at most once per call, synchronously, before your handler. Return a string of at most 1 024 characters, or `undefined` / `""` for none. A throw, a promise (an `async` function), a non-string or a longer string counts as none, with one `YAVIO-1102` warning per process; the call itself is never affected. The SDK stores `ses_` + an HMAC of the value keyed with your API key, never the value, so an id you return does not become a pseudonym anyone could recompute; it is the same in every process of the project, and rotating the API key splits a session once. `sessionKey` is code only (a function); anything else logs `YAVIO-1006` once and is ignored.

Return a **conversation** id. Funnels, paths, the step sequence and `identify()` work per session, and a session keeps its first identified user (`YAVIO-1302`). Never return:

- a per-user id on its own, such as an auth subject (`authInfo.extra.sub`) — it would chain all of that user's conversations into one endless session and one funnel attempt (combine it with a conversation id if you need both);
- `authInfo.clientId` — the OAuth client, shared by every user of a client app;
- the bearer token — a credential, and it changes when it is refreshed;
- a constant — one session for everybody;
- a per-request id (`traceparent`, a request id) — one session per call again.

Every session a process sees takes an entry in its session store (1 000, least recently used first out) and in the connection-event marks (10 000): with more concurrent conversations than that, an idle one ages out, and its next call starts over with a fresh `connection` event, no identified user and the step sequence at 0.

A call without any key on an HTTP request is `session_source: "per_request"` — on a per-request host a session of one call. The dashboard does not count it as a session (the Sessions KPI says how many such calls there were), the anonymous statistics do not count it as a person, and its `connection` event is emitted once per process per client (platform, client name and version, protocol version) instead of once per call. The widget gets the session's source with its config (`_meta.yavio.sessionSource`) and stamps it on its own events, so a per-request session's widget rows are left out the same way; a widget on an SDK before 0.5.4 sends none, and its rows count as before. On MCP SDK v1 1.24 and 1.25 one stateless transport can also be reused for every request of a long-lived server; its calls then share one connection session, labelled `per_request` all the same.

`wrap()` instruments **every tool on the server**, including the ones `buildServer()` registered before the wrap. That is the one behavioural difference to `withYavio()`, which tracks only the tools registered through the proxy it returns — a tool kept on the raw server on purpose stays untracked under `withYavio()`, and the way to limit capture for a sensitive tool under either entry point is the `tools` overrides.

`withYavio(server, options)` is safe for a server created per request too: the transport, the session store and the shutdown hooks are shared per API key and endpoint. It resolves the configuration (environment, `.yaviorc.json`) on every call, which `createYavio()` does once. Wrapping the same long-lived server again — with either entry point — returns the existing proxy, so a host that wraps on every request never stacks instrumentation. The first wrap wins: later options are ignored — any difference (another key or endpoint, other `capture` flags or `tools` overrides, `serverOnly`, intent, a `sessionKey` added or dropped, or a `wrap()` after a `withYavio()`) logs one `YAVIO-1108` warning and the first wrap's configuration keeps applying.

**Graceful shutdown.** Events are batched, so the ones from the last seconds before a scale-down or redeploy are still in memory when the signal arrives. With no handler of your own the SDK drains them within 4 s and hands the signal back (below). With a handler, stop accepting, give the requests in flight a bounded time to finish, then await `shutdown()`, then exit — `http` is the server `app.listen(port)` returned:

<!-- shutdown-recipe -->
```typescript
import type { Server } from "node:http";
// Stop accepting; let requests in flight finish; never wait longer than `ms`.
function closeWithin(server: Server, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const idle = setInterval(() => server.closeIdleConnections(), 100);
    const cap = setTimeout(() => server.closeAllConnections(), ms);
    server.close(() => {
      clearInterval(idle);
      clearTimeout(cap);
      resolve();
    }); // resolves on error too
  });
}
let stopping: Promise<void> | undefined;
function stop(): Promise<void> {
  stopping ??= (async () => {
    await closeWithin(http, 3_000);
    await analytics.shutdown(); // resolves by 4 s after the signal
    process.exit(0);
  })();
  return stopping;
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
```

Both signals, because Fly.io sends `SIGINT` by default. `stopping` makes a second signal — `npm run` forwards the terminal's Ctrl-C to a script that already got it — join the first run instead of calling `http.close()` again (`ERR_SERVER_NOT_RUNNING`) and exiting under the first close. `http.close()` alone closes the idle keep-alive sockets, but its callback waits for the socket of the request in flight at close time, which stays open after its response until the client closes it or the server's keep-alive timeout ends it (`keepAliveTimeout` plus a 1 s buffer, configurable as `keepAliveTimeoutBuffer` since Node 22.19 and 24.6: about 6 s by default on current Node, over a minute behind some load balancers), and a `Connection: close` header set once shutdown began cannot reach a response whose headers are already out — every SSE response, which is most MCP traffic today; `closeWithin` closes the idle sockets every 100 ms and cuts whatever is left at the cap, so a request that outlasts the cap is the one thing it costs.

**The deadline.** On `SIGTERM`/`SIGINT` the SDK fixes one deadline for the whole process at signal + D, where D is the smallest `shutdownTimeoutMs` set explicitly (option, `YAVIO_SHUTDOWN_TIMEOUT_MS` or `.yaviorc.json`) by any `createYavio()` client, `withYavio()` call or `shutdown()` still running when the signal arrives, else 4 s; the SDK's own drain and every `shutdown()` — your handler's included, however long the close before it took — resolve by then: one called with no time left before the SDK hands the signal back resolves at once, one called after the hand-back within D of its call. A slow or unreachable ingest therefore costs events, not the exit: what is still undelivered at the deadline is dropped, the fetch in flight is aborted, no retry is scheduled past it, and one `YAVIO-1205` line gives the count (`Shutdown deadline of 4000 ms reached — 12 events not delivered …`), plus one more when the signal was handed back before the SDK's transport stops had settled (a second signal, or a stop still settling at the deadline) — at the deadline when a `shutdown()` is still waiting then, otherwise once the transport stops have settled; the platform never has to kill the process. Requests that finish after the signal still send their events at once, one attempt each, and a `shutdown()` after the deadline waits for those at most D from its own call. Outside a signal each `shutdown()` is bounded by its own client's value from its call. `shutdownTimeoutMs` takes an integer in [100, 2147483647] milliseconds; anything else logs `YAVIO-1006` once and uses the default. Rule of thumb: `shutdownTimeoutMs` = the close cap + 1 s, and both must fit the platform's grace period:

| Platform | Grace period after the signal | Close cap | `shutdownTimeoutMs` |
|---|---|---|---|
| Fly.io (sends `SIGINT` by default) | 5 s | 3 s | 4 s (the default) |
| Cloud Run | 10 s | 3 s, or 6 s to drain longer | 4 s (the default), or 8 s |
| Kubernetes, ECS | 30 s | 20 s | 25 s |

With a healthy ingest the delivery takes about 250 ms and none of this is reached. Fastify's server is `fastify.server`, Nest's `app.getHttpServer()`; Next.js installs its own `SIGTERM`/`SIGINT` handler, which exits with 143 after `server.close()` without waiting for the SDK — set `NEXT_MANUAL_SIG_HANDLE=true` to use the recipe. A second or concurrent `shutdown()` — a framework hook and your handler — waits for the first. The transport stops once no client with the same key holds it (a `withYavio()` call never releases). A `withYavio()` host has no client to call: create one once at startup, next to the `withYavio()` calls and for the same key and endpoint, and use it only for `shutdown()`:

```typescript
const analytics = createYavio({ apiKey, endpoint }); // once, at startup; shutdown() only
withYavio(server, { apiKey, endpoint });               // per server, as before
// in the handler, as above: await analytics.shutdown();
```

Created inside the handler instead, after the SDK handed the signal back, it would install the SDK's signal listeners again and they would stay.

Without a handler the SDK drains everything on `SIGTERM`/`SIGINT` within the deadline, prints what it had to give up (one `YAVIO-1205` line), then hands the signal back: it removes its own listeners and, if it was the only listener when the signal arrived, re-raises the signal so Node's default exit runs (128 + the signal number: 130 after Ctrl-C, 143 after `SIGTERM`; set by hand on Windows) — an app with its own handler keeps control, and a second signal ends the wait: a different signal at once, the same signal once 250 ms have passed since the first — handed back for the signal that arrived, re-raised only if nothing else listens to it. The 250 ms window is a heuristic for one keypress delivered twice (`npm run` forwards the terminal's Ctrl-C to a script that already received it, a few milliseconds apart); it goes by the clock, so a deliberate second `SIGTERM` within 250 ms is taken for the same delivery and the drain runs on to the deadline, and a forward delayed past 250 ms on a loaded host ends the drain early with the events given up counted in the `YAVIO-1205` line — neither costs more than the deadline. An app that calls `process.exit()` before its `shutdown()` resolved gets one `YAVIO-1205` line at exit with what was still undelivered. After a `shutdown()` that returned in that cycle, once its deadline has come, what the deadline left — a late request's batch it cut in flight, the second event of a request served after the signal, a send in its last 100 ms — comes at exit in the deadline's wording (`Shutdown deadline of 4000 ms reached — 1 more events not delivered (in flight when the deadline cut it, …)`, "more" only after a line of that cycle), without the hint to await `shutdown()`. A library that also waits to be the last listener (signal-exit, used by execa and ora) does not get its turn, so an app that depends on it should handle the signal itself. A `401` from ingest stops delivery for that key process-wide (`YAVIO-1203`): every wrap sharing the key is affected, which is what an invalid key means.

A value that is not an `McpServer` (no `registerTool()` / `connect()`) comes back unwrapped with one `YAVIO-1107` error per process — in no-op mode too — so a mis-wired integration keeps serving. After `SIGTERM`/`SIGINT` requests still served during the graceful-shutdown window send their events at once; a `shutdown()` after them waits for those sends too.

## Captured data

Every call to a tool registered through the wrapped server produces one `tool_call` event with the tool name, latency, status and — subject to the `capture` flags — the inputs and the output.

Every event the SDK sends to `events` — `tool_call`, `connection`, `identify`, `step`, `track`, `conversion` — also carries `session_source`, how its `session_id` was derived: `mcp_session_id`, `openai_session`, `vscode_conversation`, `codex_thread`, `custom` (your `sessionKey`), `connection` (no key, not HTTP) or `per_request` (no key on an HTTP request) — see [Sessions](#stateless--per-request-servers). It names a source, never a key, and is recorded whatever the `capture` flags. The React widget stamps its server session's source on its own events too (from `_meta.yavio.sessionSource`). `tool_discovery` carries none: ingest writes it to the tool registry, which keeps no session fields. Events from SDKs before 0.5.4, server or widget, have none.

### Status and errors

A call is an error when the handler **throws** or when it **returns a result with `isError: true`** — the flag MCP uses to report tool failures to the model. Both count toward the dashboard's error rate; the `error_category` tells them apart:

| `status` | `error_category` | Meaning |
|----------|------------------|---------|
| `success` | — | The handler returned a result without `isError: true` |
| `error` | `tool_error` | The handler returned a result with `isError: true` (an expired reference, an invalid postal code, a missing field) |
| `error` | `unknown` | The handler threw |
| `error` | `validation` | The call failed **before** the handler ran: unknown or disabled tool, or arguments the tool's schema rejected. No `latency_ms` (nothing executed). By default the event has the names and types (`input_keys`, `input_types`) of the parameters the tool's schema declares, the `_`-prefixed request context in `input_values`, the client metadata and a value-free reason in `error_message` (McpServer's text as-is when it names only the tool — unknown, disabled — otherwise a fixed "Input validation error" reason), but **no argument values**, no key the model invented and no `output_content`. `rejectedInputValues: true` stores the raw arguments and McpServer's error text, to see what the model sent |
| `error` | `server` | The handler returned, but its result failed the tool's own `outputSchema` — or the MCP SDK's validation of the result on the wire |

Only the literal boolean `true` counts as `isError`. On v1 the client sees the same shape in all four error cases (the MCP SDK converts throws and pre-handler failures into `isError` results), so the distinction is server-side only. On v2 an unknown or disabled tool is a thrown JSON-RPC error instead of an `isError` result; it is still counted as `validation`.

Every `tools/call` request the wrapped server receives is counted, including the ones the MCP SDK rejects before your handler runs — a call to a tool name that does not exist shows up as that name with a 100 % error rate, which is the honest signal. Under `withYavio()` a tool registered on the original, unwrapped server stays untracked either way; `createYavio().wrap()` instruments every tool on the server (see [Stateless / per-request servers](#stateless--per-request-servers)).

`error_message` is the exception's message, or for an `isError` result the first `text` content item. Both are PII-stripped and clamped to 500 characters. The result text is output, so it is stored only while `outputValues` is on. A thrown message is developer-written, but messages routinely interpolate the arguments (`IBAN ${iban} rejected`) and the PII stripper does not recognise IBANs or customer numbers, so it is stored only while `inputValues` is on. `status` and `error_category` are recorded regardless.

Before 0.4.0 only a throw counted, so **error rates rise on upgrade** — a correction of an under-count, not a regression.

### Inputs

With `inputValues` on, `input_values` holds the tool's arguments plus a few fields from the MCP request context under `_`-prefixed keys (so they cannot collide with an argument), and the event carries the client metadata the platform relays in the request `_meta` as first-class fields: `locale`, `end_user_agent`, `subject_id` and — with `geo` on — `country_code`, plus `region` (state or province) with `geo: true` or `"region"`.

| Key | Content |
|-----|---------|
| `_meta` | The request `_meta` verbatim. On ChatGPT that is `openai/userAgent`, `openai/locale`, `openai/userLocation` (city, region, country, timezone, **latitude and longitude**), `openai/subject` (the platform's stable pseudonymous user id), `openai/session` and the client's capabilities. ChatGPT also sends the IANA `timezone` at the top level. It intentionally duplicates the first-class `locale` / `end_user_agent` / `subject_id` / `country_code` / `region` fields. With `geo: "region"` the location object is reduced to `{ country, region }`, with `geo: "country"` to `{ country }`, and with `geo: false` it is removed entirely. In all three, the rest of `_meta` keeps only `openai/locale`, `openai/userAgent`, `openai/subject` and `openai/session`; everything else is dropped — the top-level `timezone` and `timezone_offset_minutes`, the conversation and request ids (`sessionId`, `windowId`, `callId`, `itemId`, `openai/request_id`), `traceparent`, `openai/organization`, the client capabilities, and any key the platform adds later |
| `_metaDroppedKeys` / `_metaDroppedUnnamed` | With `geo` other than `true`: the names (never the values) of the `_meta` keys that were dropped, sorted, at most 20 — so a key the platform adds shows up in your data — and the number of dropped keys it does not name (a name with a run of 8 or more hex digits, which can carry an id, a malformed name, or one past the 20) |
| `_taskId` | The MCP task id, for task-based flows |
| `_requestInfo` | The calling request's `user-agent`, `accept-language`, `x-anthropic-client`, `mcp-protocol-version` and `traceparent` headers, plus its URL without the query string. Every other header is dropped — `Authorization`, `Cookie`, `X-Api-Key` and the like never reach analytics, and no `X-Forwarded-For` means an event stays free of end-user IPs |

The `connection` event's `client_name` / `client_version` — captured whatever the flags, like the `initialize` clientInfo always was — come from the protocol envelope (MCP 2026-07-28), else from the `initialize` handshake, else from the first product token of the request's `User-Agent`: `name/version` with at least one digit in the version (`openai-mcp/1.0.0` → `openai-mcp`, `1.0.0`; `OpenAI/Python 1.40.0` names no client), or a bare `name` when that is the whole User-Agent (`Claude-User` → `Claude-User`, no version). The name is accepted only for a known MCP client: a vendor the SDK's platform matcher recognises (`openai-mcp`, `Claude-User`, `claude-code`, `cursor`, `gemini-cli`, …) or an allowlisted token (`mcp-inspector`, `mcp-remote`). Every other first token names no client — a bare first word followed by more (`node …`, the `Visual` of `Visual Studio Code/1.95`), a library, runtime, browser or server-framework token (`node`, `python-httpx/0.27`, `Python/3.12 aiohttp/3.9.5`, `Java-http-client/17.0.2`, `Mozilla/5.0 …`, `Nitro/2.9.0`, `Hono/4.6.0`), and a client the SDK does not know yet — so an unrecognised name never reaches the 13-month client statistics, which are not recomputed once the raw events age out. Only the parsed name and version are stored; `metadata.client_info_source` says which source it was, because a stateless host records the User-Agent's name where a long-lived one records the handshake's (Codex driven through ChatGPT is `openai-mcp` on one and `codex-mcp-client` on the other). `protocol_version` is the request's `mcp-protocol-version` header when it has the protocol's date shape (`2025-06-18`), else unset.

**Disclose this.** With the defaults, every tool call from ChatGPT stores the user's approximate position including coordinates and the platform's stable user id. Name that collection in your privacy policy, or set `geo: "region"` (keeps the country and the state or province), `geo: "country"` (keeps only the country) or `geo: false` (no location), or `inputValues: false` (drops all of it; also per tool, see above). With `"region"`, `"country"` or `false`, the captured `_meta` holds exactly `openai/locale`, `openai/userAgent`, `openai/subject` and `openai/session` — language, device, and the platform's pseudonymous user and conversation ids — plus the location the setting allows; every other key is dropped and only its name is recorded in `_metaDroppedKeys`. The request headers stay as listed under `_requestInfo` (user agent, `accept-language`, `x-anthropic-client`, protocol version, `traceparent`). Before 0.4.1, `"country"` and `false` still kept ChatGPT's top-level `timezone` and every other `_meta` key. Note that in city-states the region *is* the city: ChatGPT reports Berlin as `State of Berlin`, and the same goes for Hamburg, Bremen, Vienna or Washington, D.C. A region name with digits or `@` is dropped, so a postal code cannot pass as one. The React widget is separate from all of this: its `widget_render` event stores the browser's time zone regardless of `capture.geo` (only when you run the widget SDK, i.e. without `serverOnly`).

**Rejected arguments are not stored by default.** A successful call only ever stores values its schema accepted, so a tool whose arguments are all enums stores only those fixed values. A call the schema rejects would otherwise store whatever the model put into the field, free text from the conversation included. With `rejectedInputValues: false`, the default, such a call keeps only the names and types of the parameters the tool's schema declares, plus a value-free reason. No value and no key the model invented is stored. Set `rejectedInputValues: true` (globally or per tool) only if you want to see the values the model sent, and disclose it.

All captured input and output is PII-stripped before it leaves the process, but the stripper only matches emails, Luhn-valid card numbers, US Social Security numbers and US-format phone numbers.

## Tracking API

Import `yavio` and call methods inside tool handlers — context is propagated automatically. A call from outside a wrapped tool call has no session or trace to attach to: the event is dropped and the SDK warns once per process (`YAVIO-1105`). If that warning shows up, the tool is registered on the unwrapped server — move it onto the wrapped one and use `tools` overrides to limit what is captured for it.

```typescript
import { yavio } from "@yavio/sdk";

// Associate events with a user: one identify event per session per process,
// again only when a trait changes — safe to call in every handler
yavio.identify("user-123", { plan: "pro" });

// Record funnel steps (auto-incrementing sequence)
yavio.step("onboarding_start");
yavio.step("onboarding_complete");

// Record custom events
yavio.track("file_uploaded", { size: 1024 });

// Record revenue
yavio.conversion("purchase", {
  value: 29.99,
  currency: "USD",
});
```

## React Widget

For client-side tracking in MCP-powered UIs:

```bash
npm install @yavio/sdk react react-dom
```

```tsx
import { useYavio } from "@yavio/sdk/react";

function App() {
  const yavio = useYavio();

  // yavio.identify(), yavio.track(), yavio.step(), yavio.conversion()

  return <div>...</div>;
}
```

The widget auto-captures clicks, scrolls, form interactions, navigation, errors, performance metrics, and rage clicks. Configuration is resolved from tool result metadata (`_meta.yavio`) or passed explicitly to the hook.

## PII Protection

Email addresses, credit card numbers, SSNs, and phone numbers are automatically stripped from event payloads before they leave the client.

## Documentation

Full documentation is available at [docs.yavio.ai](https://docs.yavio.ai/docs).

## License

[MIT](./LICENSE)
