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

Tool calls, inputs, outputs, and timing are captured automatically. Custom events are optional. Events are batched and sent in the background; when the process ends — its client closes a stdio server's stdin, or a `SIGTERM`/`SIGINT` arrives — the SDK sends what is still queued first, without shutdown code of yours (see [stdio servers](#stdio-servers) and **Graceful shutdown** under [Stateless / per-request servers](#stateless--per-request-servers)). On a platform that freezes the instance once the response is out — AWS Lambda, Vercel, Cloudflare Workers, Cloud Run with request-based billing — call `analytics.flush()` or `analytics.flushWhenSent()` per request (see [Serverless and edge runtimes](#serverless-and-edge-runtimes)).

## Configuration

The SDK resolves config in order:

1. Options passed to `withYavio(server, options)`
2. Environment variables `YAVIO_API_KEY`, `YAVIO_ENDPOINT` (and `YAVIO_SERVER_ONLY`, `YAVIO_INTENT`, `YAVIO_SHUTDOWN_TIMEOUT_MS`, `YAVIO_FLUSH_TIMEOUT_MS`, `YAVIO_WAIT_UNTIL_TIMEOUT_MS`)
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
    conversationId: true, // the platform's raw conversation ids in input_values._meta (default: true), see below
    rejectedInputValues: false, // argument values of calls the schema rejected (default: false), see below
    tokens: true,        // reserved — no effect today
    retries: true,       // reserved — no effect today (is_retry is never set)
  },
  tools: {               // per-tool overrides of the capture flags (default: none)
    "book-contract": { inputValues: false, outputValues: false, intent: false },
  },
  shutdownTimeoutMs: 4_000, // deadline for delivering queued events on shutdown: an integer in [100, 2147483647] ms (default: 4 s); on SIGTERM/SIGINT one deadline for the whole process, the smallest value set explicitly, see Stateless
  flushTimeoutMs: 1_000,    // how long createYavio().flush() waits for ingest: an integer in [100, 2147483647] ms (default: 1 s); nothing is dropped at it, see Serverless
  waitUntilTimeoutMs: 10_000, // how long flushWhenSent()'s flush, in waitUntil, may wait for the batch it sent (default: 10 s), see Serverless
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

### stdio servers

A stdio server ends when its client closes the server's stdin. A server that holds nothing else (no database pool, no file watcher, no timer of its own) then exits on its own, without a signal and without a `shutdown()` call. Since 0.5.5 the SDK sends what is still queued at that point before the process goes, within 1.5 s or a lower `shutdownTimeoutMs`, and counts what it could not deliver in one line at exit:

```text
[YAVIO-1205] Exit deadline of 1500 ms reached — 6 events not delivered (the process ended on its own with events queued; queued, in flight or refused after the deadline). To wait longer, await analytics.shutdown() before the event loop empties (on stdin's end or at the end of the script; a beforeExit listener is too late).
```

A higher `shutdownTimeoutMs` does not raise the 1.5 s: the MCP TypeScript clients send `SIGTERM` 2 s after they close stdin, and the drain ends before that. With nothing queued the exit is as fast and as quiet as without the SDK. The same holds for every process that ends on its own with events queued — a script or CLI that never calls `shutdown()`, a host that closes its server without a signal. Before 0.5.5 those events were lost without a line. `process.exit()` skips this: call it only after `await analytics.shutdown()`. On AWS Lambda's Node 20/22 runtimes the drain runs after every invocation of a callback-style handler, because the runtime client answers it from its own `beforeExit` listener. Streaming handlers there wait for an empty loop as well, so their billed invocation can last until the drain's stops settle (at most the 1.5 s bound). On Lambda, use `flush()` (since 0.5.5, see [Serverless and edge runtimes](#serverless-and-edge-runtimes)).

How clients end a stdio server:

| Client | What it does |
|---|---|
| MCP TypeScript SDK `StdioClientTransport.close()`, v1 and v2 (and hosts built on it) | closes stdin; `SIGTERM` 2 s later, `SIGKILL` 2 s after that |
| VS Code | closes stdin; a polite tree kill (`SIGTERM`, skipped on Windows) 10 s later, a forceful one 10 s after that |
| Claude Code on macOS and Linux | `SIGINT`, `SIGTERM` 100 ms later, `SIGKILL` 500 ms after the `SIGINT` — it does not close stdin, so the signal path applies, not this one. Since 0.5.5 the SDK keeps sending until 400 ms after the `SIGINT`, before the `SIGKILL`, and counts what it could not deliver in one line (see [The deadline](#the-deadline)); before, the `SIGTERM` ended the drain after about 100 ms, and a batch on a fresh connection to a remote ingest never left the machine |
| Claude Code on Windows | closes stdin, then kills the process tree 300 ms later: the drain completes only if ingest answers within that |

A server with handles of its own does not exit when stdin ends; the client's `SIGTERM` 2 s later ends it on the signal path. To end it the stdio way, shut down when stdin ends:

```typescript
const analytics = createYavio({ serverOnly: true, shutdownTimeoutMs: 1_500 });
process.stdin.on("end", async () => {
  await analytics.shutdown(); // within 1.5 s: before the client's SIGTERM at 2 s
  process.exit(0); // your own handles no longer keep the process
});
```

It needs `shutdownTimeoutMs: 1_500`: with the default 4 s and a hanging ingest, the client's `SIGKILL` at 4 s comes first and no line is printed. Either entry point works. With `withYavio()`, create the client above once at startup, for the same key and endpoint as the `withYavio()` calls, and use it only for `shutdown()`: since 0.5.5 its `shutdown()` stops the transport those servers share like any last client's — at its deadline the fetch in flight is aborted and one `shutdown() deadline of 1500 ms reached — N events not delivered` line counts the loss — and a fresh transport takes over for them. A call that finishes during that `shutdown()` joins it and is delivered with it (or counted in its line), as on any drain. That holds for a client that never wraps a server, as here; a client that also wraps servers on the pinned key only drains it (see [Graceful shutdown](#stateless--per-request-servers)). Before 0.5.5 it only drained a key `withYavio()` uses: against a hanging ingest the recipe's `process.exit(0)` ended with `Process exit with N events not delivered — await analytics.shutdown() …`, a hint that does not fit a process that did await it, and without `process.exit()` the hanging fetch kept the process up for about 30 s; wrap with `createYavio().wrap()` there. On 0.5.4 and earlier, which lose the queue on a natural exit, the one-line workaround is `process.once("beforeExit", () => void analytics.shutdown());`. Drop it on 0.5.5: the SDK drains on its own, and its listener, installed by `createYavio()`, runs before one registered after it, so the workaround's `shutdown()` only waits for that 1.5 s drain. To wait longer than 1.5 s, await `analytics.shutdown()` before the event loop empties — on stdin's `end` as above, or at the end of a script's main — since a `beforeExit` listener is too late.

stdout is the JSON-RPC wire of a stdio server, so the SDK writes nothing there: every line it prints goes to stderr. Before 0.5.5 its informational lines (`[yavio] Server-only mode: …`, `[yavio] Intent capture enabled: …`) went to stdout, and the client reported each one as a line that is not JSON.

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

On MCP SDK v2 only the imports differ: `McpServer` from `@modelcontextprotocol/server`, `NodeStreamableHTTPServerTransport` from `@modelcontextprotocol/node`, or `createMcpHandler((ctx) => analytics.wrap(buildServer()))`. Over HTTP only `createMcpHandler` serves MCP 2026-07-28; a server connected to a transport per request, as above, stays on the 2025 era (see [MCP 2026-07-28](#mcp-2026-07-28)).

What holds across instances **and across processes** (a fleet behind a load balancer, where any instance serves any request): the same `session_id` for the same conversation (any key in the table below), and the client identity on the `connection` event even though the instance serving `tools/call` never saw `initialize` (see [Captured data](#captured-data)). What is **per process**: `yavio.identify()` on one request is visible on the next only when the same process serves it, and each process sends its `identify` event once per session, and again only when a trait changes (since 0.5.4); the dashboard and the statistics count every event of the conversation for its first identified user across processes (#145), and ChatGPT users also by `openai/subject`; the step sequence restarts per process (funnels order a conversation's steps by time); the `connection` event is emitted at least once per session per process and `tool_discovery` once per tool per process, so a conversation served by six instances has six connection rows — nothing counts them (sessions are distinct `session_id`s everywhere, discovery rows collapse per tool). Widget tokens are minted per tool call in non-serverOnly mode, as the ingest contract requires (a token is bound to the trace of the call that minted it); the mint is bounded by a 2 s timeout, after which the result goes out without `_meta.yavio`.

**Sessions.** A per-request server has no session of its own: a stateless transport never issues `Mcp-Session-Id`, and the 2026-07-28 protocol era drops the header. The SDK takes a call's session from the first of these keys it finds, and every event says which in `session_source`:

| Order | Key | `session_source` |
|---|---|---|
| 1 | `Mcp-Session-Id` (a sessionful transport) | `mcp_session_id` |
| 2 | ChatGPT's `_meta["openai/session"]` | `openai_session` |
| 3 | VS Code / Copilot Chat's `_meta["vscode.conversationId"]`, from any client | `vscode_conversation` |
| 4 | The Codex CLI's `_meta.threadId` — only from `codex-mcp-client` (named by its envelope, its `initialize` or its User-Agent): a bare `threadId` from another client is not trusted | `codex_thread` |
| 5 | Your `sessionKey` option | `custom` |
| — | None of them: on an HTTP request a session of its own for that one call, on every host; on stdio the client process's | `per_request` / `connection` |

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

Every session a process sees takes an entry in its session store (1 000, least recently used first out) and in the connection-event marks (10 000): with more concurrent conversations than that, an idle one ages out, and its next call starts over with a fresh `connection` event, no identified user and the step sequence at 0. A call without a key on an HTTP request takes no entry in the session store, and its connection-event mark is one per client (below).

A call without any key on an HTTP request is `session_source: "per_request"` — a session of one call, on every host. The dashboard does not count it as a session (the Sessions KPI says how many such calls there were), the anonymous statistics do not count it as a person, and its `connection` event is emitted once per process per client (platform, client name and version, protocol version) instead of once per call. The widget gets the session's source with its config (`_meta.yavio.sessionSource`) and stamps it on its own events, so a per-request session's widget rows are left out the same way; a widget on an SDK before 0.5.4 sends none, and its rows count as before. Each such call is its own session on every host, also on a long-lived server that reuses one stateless transport for every request (MCP SDK v1 1.24 and 1.25 allow it; before 0.5.5 those calls shared one session, and the first identified user, platform and step count landed on every caller). Reusing a transport across requests is the pattern of the MCP SDK advisory [GHSA-345p-7cg4-v4c7](https://github.com/advisories/GHSA-345p-7cg4-v4c7) (CVE-2026-25536, a cross-client data leak in the MCP SDK itself): use MCP SDK 1.26 or later with a transport per request.

`wrap()` instruments **every tool on the server**, including the ones `buildServer()` registered before the wrap. That is the one behavioural difference to `withYavio()`, which tracks only the tools registered through the proxy it returns — a tool kept on the raw server on purpose stays untracked under `withYavio()`, and the way to limit capture for a sensitive tool under either entry point is the `tools` overrides.

`withYavio(server, options)` is safe for a server created per request too: the transport, the session store and the shutdown hooks are shared per API key and endpoint. It resolves the configuration (environment, `.yaviorc.json`) on every call, which `createYavio()` does once. Wrapping the same long-lived server again — with either entry point — returns the existing proxy, so a host that wraps on every request never stacks instrumentation. The first wrap wins: later options are ignored — any difference (another key or endpoint, other `capture` flags or `tools` overrides, `serverOnly`, intent, a `sessionKey` added or dropped, or a `wrap()` after a `withYavio()`) logs one `YAVIO-1108` warning and the first wrap's configuration keeps applying.

**Graceful shutdown.** Events are batched, so the ones from the last seconds before a scale-down or redeploy are still in memory when the signal arrives (a stdio server ends without a signal: see [stdio servers](#stdio-servers)). With no handler of your own the SDK drains them within 4 s and hands the signal back (below). With a handler, stop accepting, give the requests in flight a bounded time to finish, then await `shutdown()`, then exit — `http` is the server `app.listen(port)` returned:

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

<a id="the-deadline"></a>**The deadline.** On `SIGTERM`/`SIGINT` the SDK fixes one deadline for the whole process at signal + D, where D is the smallest `shutdownTimeoutMs` set explicitly (option, `YAVIO_SHUTDOWN_TIMEOUT_MS` or `.yaviorc.json`) by any `createYavio()` client, `withYavio()` call or `shutdown()` still running when the signal arrives, else 4 s; the SDK's own drain and every `shutdown()` — your handler's included, however long the close before it took — resolve by then: one called with no time left before the SDK hands the signal back resolves at once, one called after the hand-back within D of its call. A slow or unreachable ingest therefore costs events, not the exit: what is still undelivered at the deadline is dropped, the fetch in flight is aborted, no retry is scheduled past it, and one `YAVIO-1205` line gives the count (`Shutdown deadline of 4000 ms reached — 12 events not delivered …`), plus one more when the signal was handed back before the SDK's transport stops had settled (a second signal, or a stop still settling at the deadline) — at the deadline when a `shutdown()` is still waiting then, otherwise once the transport stops have settled; the platform never has to kill the process. Requests that finish after the signal still send their events at once, one attempt each, and a `shutdown()` after the deadline waits for those at most D from its own call. Outside a signal each `shutdown()` is bounded by its own client's value from its call. One signal order moves the deadline in: a `SIGTERM` after the `SIGINT` that started the drain — Claude Code's stop sequence for a stdio server, `SIGINT`, `SIGTERM` 100 ms later, `SIGKILL` 400 ms after that — ends it by 400 ms after the `SIGINT`, or at signal + D when that is sooner — and never later than 300 ms after the `SIGTERM`, which only decides when a busy process handled both signals late (since 0.5.5). The SDK's drain, every `shutdown()` and `flush()` waiting on it, and the fetches of requests served afterwards follow that earlier deadline, and the line names it instead of D, without the hint to raise `shutdownTimeoutMs`, which cannot extend it: `Shutdown deadline of 400 ms (SIGTERM 102 ms after SIGINT) reached — 6 events not delivered (queued, in flight or refused after the deadline). The client stops the server with SIGINT, SIGTERM and SIGKILL (Claude Code: 100 ms, then 400 ms); a higher shutdownTimeoutMs does not extend that.` A process that ends on its own with events queued — no signal, no `shutdown()` — drains within min(1.5 s, D) instead: a lower explicit `shutdownTimeoutMs` lowers that bound, a higher one does not raise it ([stdio servers](#stdio-servers)). `shutdownTimeoutMs` takes an integer in [100, 2147483647] milliseconds; anything else logs `YAVIO-1006` once and uses the default. Rule of thumb: `shutdownTimeoutMs` = the close cap + 1 s, and both must fit the platform's grace period:

| Platform | Grace period after the signal | Close cap | `shutdownTimeoutMs` |
|---|---|---|---|
| Fly.io (sends `SIGINT` by default) | 5 s | 3 s | 4 s (the default) |
| Cloud Run | 10 s | 3 s, or 6 s to drain longer | 4 s (the default), or 8 s |
| Kubernetes, ECS | 30 s | 20 s | 25 s |

With a healthy ingest the delivery takes about 250 ms and none of this is reached. Fastify's server is `fastify.server`, Nest's `app.getHttpServer()`; Next.js installs its own `SIGTERM`/`SIGINT` handler, which exits with 143 after `server.close()` without waiting for the SDK — set `NEXT_MANUAL_SIG_HANDLE=true` to use the recipe. A second or concurrent `shutdown()` — a framework hook and your handler — waits for the first. The transport stops once no other client with the same key holds it. On a key a `withYavio()` call uses, it stops only at the `shutdown()` of a client that never wrapped a server — the shutdown-only client below, whose `shutdown()` ends the process — and then whatever other clients still hold it; a fresh transport takes over at once, so those servers keep sending (since 0.5.5; before, that `shutdown()` only drained such a key, and its deadline neither aborted the fetch nor counted the loss). A client that wraps servers only drains a key a `withYavio()` call uses, as before. Such a `shutdown()` is for the end of the process: a host that creates and shuts down never-wrapping clients per request gives up the `withYavio()` servers' queue at each of them against a failing ingest (4 of 36 calls in the 3 s outage measured below). A `withYavio()` host has no client to call: create one once at startup, next to the `withYavio()` calls and for the same key and endpoint, and use it only for `shutdown()`:

```typescript
const analytics = createYavio({ apiKey, endpoint }); // once, at startup; shutdown() only
withYavio(server, { apiKey, endpoint });               // per server, as before
// in the handler, as above: await analytics.shutdown();
```

Created inside the handler instead, after the SDK handed the signal back, it would install the SDK's signal listeners again and they would stay. One client for the process is the pattern. A host that pins a key with `withYavio()` and also creates, wraps with and shuts down `createYavio()` clients per request on the same key keeps the behaviour of 0.5.4 and earlier: those clients wrap, so their `shutdown()` only drains the shared transport, and through an ingest outage the `withYavio()` servers' queue waits for the next retry (with a `withYavio()` server called every 100 ms, a per-request client every 500 ms and a 3 s outage, all 36 calls arrive once ingest is back). The cost stays as well: an app that both wraps servers and pins the same key gets a drain on its last `shutdown()`, which against a hanging ingest aborts no fetch. With `process.exit()` after it, the exit hook's `Process exit …` line counts the loss; without, the fetch can hold the process until its 30 s timeout, and the natural-exit drain's `Exit deadline of 1500 ms reached — 53 events …` comes at about 31.6 s (measured). On such a host, create the wrapping client once at startup, wrap with it per request and `await analytics.flush()` at each request's end; end the process with a shutdown-only client that never wraps, whose `shutdown()` stops the key's transport even while the wrapping client still holds it. Do not create a client per request and call `flush()` instead of its `shutdown()`: a client holds the key from its creation until its `shutdown()`, so each of them would stay registered for the life of the process.

Without a handler the SDK drains everything on `SIGTERM`/`SIGINT` within the deadline, prints what it had to give up (one `YAVIO-1205` line), then hands the signal back: it removes its own listeners and, if it was the only listener when the signal arrived, re-raises the signal so Node's default exit runs (128 + the signal number: 130 after Ctrl-C, 143 after `SIGTERM`; set by hand on Windows) — an app with its own handler keeps control, and a second signal ends the wait: a different signal at once, the same signal once 250 ms have passed since the first — handed back for the signal that arrived, re-raised only if nothing else listens to it. The one exception is a `SIGTERM` after the `SIGINT`, a client's stop sequence: the wait ends by 400 ms after the `SIGINT` instead (see the deadline above), and then the `SIGTERM` is handed back; a `SIGTERM` followed by a `SIGINT` still ends it at once, and so does a third signal. The 250 ms window is a heuristic for one keypress delivered twice (`npm run` forwards the terminal's Ctrl-C to a script that already received it, a few milliseconds apart); it goes by the clock, so a deliberate second `SIGTERM` within 250 ms is taken for the same delivery and the drain runs on to the deadline, and a forward delayed past 250 ms on a loaded host ends the drain early with the events given up counted in the `YAVIO-1205` line — neither costs more than the deadline. An app that calls `process.exit()` before its `shutdown()` resolved gets one `YAVIO-1205` line at exit with what was still undelivered. A process that ends on its own with events queued gets one line at exit for what its natural-exit drain could not deliver (`Exit deadline of 1500 ms reached — 6 events not delivered (the process ended on its own with events queued; …)`), and none with nothing queued. After a `shutdown()` that returned in that cycle, once its deadline has come, what the deadline left — a late request's batch it cut in flight, the second event of a request served after the signal, a send in its last 100 ms — comes at exit in the deadline's wording (`Shutdown deadline of 4000 ms reached — 1 more events not delivered (in flight when the deadline cut it, …)`, "more" only after a line of that cycle), without the hint to await `shutdown()`. A library that also waits to be the last listener (signal-exit, used by execa and ora) does not get its turn, so an app that depends on it should handle the signal itself. A `401` from ingest stops delivery for that key process-wide (`YAVIO-1203`): every wrap sharing the key is affected, which is what an invalid key means.

A value that is not an `McpServer` (no `registerTool()` / `connect()`) comes back unwrapped with one `YAVIO-1107` error per process — in no-op mode too — so a mis-wired integration keeps serving. After `SIGTERM`/`SIGINT` requests still served during the graceful-shutdown window send their events at once; a `shutdown()` after them waits for those sends too.

### MCP 2026-07-28

MCP 2026-07-28 is the stateless protocol revision: the client opens with `server/discover` instead of `initialize`, every request carries the client's name, version, capabilities and protocol version in an envelope in its `_meta`, there is no `Mcp-Session-Id`, and the server cannot send requests to the client. Which revision a connection gets depends on the server's entry point and on what the client asks for, not on the transport:

| Server | Client | Revision |
|---|---|---|
| MCP SDK v2 `createMcpHandler` (Streamable HTTP) or `serveStdio` | asks for 2026-07-28: `versionNegotiation: { mode: "auto" }` on the v2 client, or a pin | 2026-07-28 |
| MCP SDK v2 `createMcpHandler` or `serveStdio` | anything else, the v2 client's default included | 2025-11-25 or older |
| MCP SDK v2 `McpServer.connect()` on any transport: `InMemoryTransport`, a `NodeStreamableHTTPServerTransport` per request or long-lived | any; a client pinned to 2026-07-28 fails to connect | 2025-11-25 or older |
| MCP SDK v1 | any; a client pinned to 2026-07-28 fails to connect | 2025-11-25 or older: v1 has no 2026-07-28 |

On 2026-07-28 the SDK takes the `connection` event's client name and version, `protocol_version` and `metadata.client_capabilities` from the envelope, with `metadata.client_info_source: "envelope"` (see [Inputs](#inputs)). Sessions come from the keys in the [Sessions](#stateless--per-request-servers) table or your `sessionKey`; without one, a call over HTTP is a session of its own (`per_request`), and the calls on a stdio connection share its session (`connection`), as on the 2025 era. A tool that asks for input with `inputRequired()` is one `tool_call` (since 0.5.5), from the client's final retry (see [Tools that ask for input](#tools-that-ask-for-input)).

**Server-to-client requests throw on 2026-07-28.** Inside a 2026-07-28 request, `ctx.mcpReq.elicitInput()`, `ctx.mcpReq.requestSampling()` (`server.server.createMessage()`), `server.server.listRoots()` and `server.server.ping()` throw `Server-to-client requests are not available on protocol revision 2026-07-28: …`. Unless the handler catches it, the client gets an `isError` result, and the call is one `error` / `unknown` event with that text as its `error_message` (stored while `inputValues` is on). So a tool that moves to `createMcpHandler` or `serveStdio` shows `unknown` errors from every client that negotiates 2026-07-28. Return `inputRequired()` instead: it works on both revisions, because on the 2025 era v2's shim asks the client within the same request.

**A 2025-era client of a per-request host cannot be asked either**, with either style: the instance serving its `tools/call` has no channel back to the client. `elicitInput()` fails at once, because that instance never saw the client's `initialize` and so knows no elicitation capability. `requestSampling()`, `listRoots()` and `ping()` never reach the client and wait for the MCP SDK's request timeout (60 s by default). The client's own `callTool()`, whose default timeout is also 60 s, fails with `Request timed out` at about the same moment, so the user sees a timeout, not an error result. Each such call is one `error` / `unknown` event, the timeouts with a `latency_ms` of about 60 000, and `inputRequired()` there is one `error` / `server` event. To ask 2025-era clients for input, serve their requests from a sessionful wiring: route each request for which v2's `isLegacyRequest(request)` is true to a long-lived server per session (a `WebStandardStreamableHTTPServerTransport` with a `sessionIdGenerator`), and everything else to `createMcpHandler(factory, { legacy: "reject" })`, as the `isLegacyRequest` documentation shows. Otherwise, do not ask a 2025-era client for input on a per-request host, or pass a short `timeout` to `requestSampling()` / `listRoots()` so that the handler fails before the client gives up.

**A re-sent call can count twice.** 2026-07-28 has no stream resumption (no `Last-Event-ID`; a closed response stream cancels the request), and on stdio a request in flight when the server process dies is lost, for the client to send again to the new process. When the first attempt finished — the stream broke after the handler returned, or the server restarted after the call's event was sent — the re-sent call is a second `tool_call` event. Nothing links the two: the second request may reach another instance, and `is_retry` is never set. A call still in its handler when the process died has no event (the event is built when the handler returns, and the queue ends with the process), so its re-sent call is the only one.

**Task-based tools are not tracked**, on any revision. A tool registered with MCP SDK v1's `server.experimental.tasks.registerToolTask()` (the experimental tasks of MCP 2025-11-25) records nothing for any call to it, under `withYavio()` or `wrap()`: no `tool_call` for a task-augmented call, for a plain call to a `taskSupport: "optional"` tool (which v1 answers by polling the task itself) or for a call the MCP SDK refuses because it lacks task augmentation, and no `tool_discovery`. MCP SDK v2 has no server-side task API; a task handle that a v2 `registerTool()` handler returns fails v2's own result validation and is one `error` / `server` event.

### Serverless and edge runtimes

The SDK runs on Node.js ≥ 20 hosts with the recipes below. How far each runtime has been checked differs, and the table's last column says:

- **AWS Lambda:** in an emulation of its Node 20/22 runtime client and its freeze.
- **Cloudflare Workers:** on a local workerd, with `nodejs_compat` and a compatibility date of 2025-09-15 or later, not on Cloudflare's edge.
- **Vercel, Cloud Run and Netlify:** from their documentation only.

The Vercel Edge runtime and Netlify Edge Functions cannot load the SDK, and Deno and Bun are untested.

Most of these platforms freeze or throttle the instance once the response is out. A frozen process runs no timers, and the platform may recycle it without a signal the app could act on. Events wait for a 10 s interval, so before 0.5.5 the last invocations' events were lost without a line. Since 0.5.5:

- `await analytics.flush()` sends what is queued at the call and waits until ingest has answered it. Events queued after the call are the next flush's. Use it where the platform has no `waitUntil`, once the response body is complete and before the handler returns.
- `analytics.flushWhenSent(response, waitUntil)` returns the response to send instead and hands the platform's `waitUntil` a flush that starts once the body has been sent. Use it where the platform has a `waitUntil`: it adds nothing to the response time. Pass Vercel's `waitUntil` function, or a context that has one (Cloudflare's `ctx`, Netlify's `context`), not `ctx.waitUntil` on its own, which workerd rejects with "Illegal invocation".

Both wait at most `flushTimeoutMs` (1 s by default; option, `YAVIO_FLUSH_TIMEOUT_MS` or `.yaviorc.json`). One exception: the flush `flushWhenSent()` hands to `waitUntil` delays no response, so when the batch it sent is still out at `flushTimeoutMs`, it keeps waiting for that answer, up to `waitUntilTimeoutMs` (10 s by default; option, `YAVIO_WAIT_UNTIL_TIMEOUT_MS` or `.yaviorc.json`). On Workers a fetch dies with its request once that flush ends, so an ingest slower than `flushTimeoutMs` needs this wait. Only the flush with a fetch of its own out waits, and no other flush takes that batch back meanwhile. Once it is answered, that flush also sends the events of concurrent requests whose flushes gave up waiting on its batch, if another round trip fits before `waitUntilTimeoutMs`. Their own flushes stop at `flushTimeoutMs`. On Vercel the function runs as long as `waitUntil` holds it, so lower the value there if an ingest that hangs must cost less. Neither rejects nor drops anything: what ingest did not take stays queued for the next flush, and one `YAVIO-1208` line says so until a flush delivers everything again, at most one a minute: a second stall within a minute of the last line is reported by the first flush after the minute if it still lasts then, and one that ends within the minute prints nothing. A flush that gives up waiting on another running flush's batch prints nothing: that flush sends its events and reports for them. A batch that waits for a retry after a failed send is retried at once by a flush, once per flush, when its last attempt is at least a second old; that attempt does not count towards the retry limit. A `Retry-After` from ingest, on a 429 or a 503, is never cut short. A send that an earlier request left in flight is taken back once it is older than `flushTimeoutMs`, and its batch re-sent unchanged. After a freeze its connection is likely dead, and on Workers it never answers once its request has ended. The bound doubles each time the same batch is taken back, and it is at least twice ingest's last round trip, so an ingest that is only slow keeps its batches. That floor is capped at four times `flushTimeoutMs`, so one slow answer does not hold the next hung fetch for long. If the first send had reached ingest after all, ingest stores both copies. ClickHouse drops the second when it makes up an insert block of its own (the dedup token over event id and timestamp). Otherwise the table's ReplacingMergeTree collapses the two at merge time, and until then a query without `FINAL` or `LIMIT 1 BY event_id` counts the event twice. Both keep the transport, so the next request's `wrap()` finds it, and a flush sends the events of every request on the instance. Concurrent flushes share the batches, so each event goes out once. With a healthy ingest a flush is one round trip, or two when another batch is in flight (about 55 ms and 85 ms against an ingest that answers in 50 ms). That holds under steady traffic too: a request every 5 ms gives a flush p50 of 85 ms. `shutdown()` is for the end of the process, not for every request.

| Runtime | After the response | Recipe | Checked |
|---|---|---|---|
| AWS Lambda (Node 20, 22, 24), buffered | frozen until the next invocation; recycled after hours or when idle, with `SIGTERM` only when an extension is registered | `await analytics.flush()` once the body is complete | emulated: the Node 20/22 runtime client's loop and freeze |
| Lambda response streaming | the invocation lasts until the handler's promise settles | pipe the body, then `await analytics.flush()` | docs only |
| Lambda Managed Instances | not frozen | none: a long-lived host | docs only |
| Vercel Functions, Node runtime | suspended until the next invocation | `flushWhenSent(response, waitUntil)`, or Next.js `after(() => analytics.flush())` | docs only; `after()` read in the Next.js 16.3 source |
| Cloudflare Workers, `nodejs_compat`, date ≥ 2025-09-15 | timers end with the request | `flushWhenSent(response, ctx)` | local workerd: sequential and concurrent requests, also together against an ingest that stays slower than `flushTimeoutMs`; one slow answer; a failing ingest; not the edge |
| Cloud Run, request-based billing (the default) | CPU throttled until the next request; `SIGTERM` with 10 s at the end | `await analytics.flush()` before the response is sent, or instance-based billing | docs only |
| Netlify Functions | on AWS Lambda | `flushWhenSent(response, context)` | docs only, untested |
| Vercel Edge runtime, Netlify Edge Functions | no `node:fs`, `node:crypto` or `node:os` | not supported | docs |
| Deno Deploy, Bun | — | — | untested |

The recipes use MCP SDK v2's `createMcpHandler`, which takes a web `Request` and returns a web `Response`. Create both once per instance, at module scope:

<!-- recipe:shared -->
```typescript
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { createYavio } from "@yavio/sdk";

export const analytics = createYavio({ serverOnly: true });
export const mcp = createMcpHandler(() => analytics.wrap(buildServer()));

function buildServer(): McpServer {
  const server = new McpServer({ name: "example", version: "1.0.0" });
  // server.registerTool(…) as usual
  return server;
}
```

**AWS Lambda.** Behind a function URL or an API Gateway HTTP API (payload format 2.0), the event turned into a web `Request` (both Lambda recipes use this):

<!-- recipe:lambda-request -->
```typescript
export interface HttpEvent {
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string>;
  body?: string;
  isBase64Encoded: boolean;
  requestContext: { http: { method: string } };
}

export function toRequest(event: HttpEvent): Request {
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const body =
    event.body && (event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body);
  return new Request(`https://${event.headers.host}${event.rawPath}${query}`, {
    method: event.requestContext.http.method,
    headers: event.headers,
    body: body || undefined,
  });
}
```

Take the whole body first, so every tool call has ended and queued its event, then flush and return. The flush adds one ingest round trip to the invocation:

<!-- recipe:lambda -->
```typescript
export const handler = async (event: HttpEvent) => {
  const response = await mcp.fetch(toRequest(event));
  const body = await response.text();
  await analytics.flush();
  return { statusCode: response.status, headers: Object.fromEntries(response.headers), body };
};
```

Lambda's Node 20 and 22 runtimes also run the SDK's natural-exit drain after every invocation of a callback-style handler (see [stdio servers](#stdio-servers)), but only as a race with the freeze. An `await analytics.flush()` before the callback leaves that drain nothing to do.

**Lambda response streaming.** The client has the whole body once it is piped; the invocation, and its billing, lasts until the flush after it has settled:

<!-- recipe:lambda-streaming -->
```typescript
import { Writable } from "node:stream";

export const handler = awslambda.streamifyResponse(async (event: HttpEvent, responseStream) => {
  const response = await mcp.fetch(toRequest(event));
  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers),
  });
  if (response.body) await response.body.pipeTo(Writable.toWeb(stream));
  else stream.end();
  await analytics.flush();
});
```

**Vercel.** A Next.js route handler on the Node runtime (Fluid compute). The flush runs after the response, on Vercel's `waitUntil`:

<!-- recipe:vercel -->
```typescript
// app/mcp/route.ts
import { waitUntil } from "@vercel/functions";

export async function POST(request: Request): Promise<Response> {
  return analytics.flushWhenSent(await mcp.fetch(request), waitUntil);
}
```

Next.js's own `after()` (stable since Next.js 15.1) should work too. In a route handler it runs its callbacks once the response has closed, after a streamed body has been sent. That is from the Next.js 16.3 source (the route handler's `res.on("close")`); it has not been run:

<!-- recipe:next-after -->
```typescript
import { after } from "next/server";

export async function POST(request: Request): Promise<Response> {
  after(() => analytics.flush());
  return mcp.fetch(request);
}
```

`waitUntil(analytics.flush())` right after `mcp.fetch()` is too early. Most clients today get the answer as a Server-Sent Events stream, and `fetch()` resolves before the tool call has ended and queued its event, so each call's event waits for the next invocation and the last one is lost.

**Cloudflare Workers.** Set `compatibility_flags = ["nodejs_compat"]` and a `compatibility_date` of 2025-09-15 or later. Pass the context itself:

<!-- recipe:workers -->
```typescript
export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    return analytics.flushWhenSent(await mcp.fetch(request), ctx);
  },
};
```

Without `waitUntil` a Worker sends nothing at all, because its timers end with the request. A fetch or a retry wait that outlives its request never settles there. `flushWhenSent()` waits for the batch it sent, up to `waitUntilTimeoutMs`, so an answer within that time arrives before the request ends. What still outlives a request — a hang longer than that, a batch another request's flush sent — is taken back and sent again by the next request's flush. If no later request comes before Cloudflare evicts the isolate, that batch is lost. With `ctx.waitUntil(analytics.flush())` instead of `flushWhenSent()`, the flush stops at `flushTimeoutMs`: set it above ingest's worst latency, or a slow ingest never gets an answer through. This was checked on a local workerd, not on Cloudflare's edge, with:

- concurrent requests;
- an ingest slower than `flushTimeoutMs`, for one request and for all of them;
- bursts of 3 and 5 concurrent requests against such an ingest;
- an ingest that fails twice.

`createYavio()` at module scope works since 0.5.5. Before that it threw "Disallowed operation called within global scope", and every batch failed with "Illegal invocation".

**Cloud Run with request-based billing.** The CPU is throttled outside requests, so a flush after the response stalls until the next request, and what is left is drained at `SIGTERM`. Flush before the response is sent, as in the Lambda recipe: take the body, `await analytics.flush()`, then write it. Alternatively, switch the service to instance-based billing, which keeps the CPU and needs neither. With a transport that writes the response itself (the Express recipe above, the Lambda Web Adapter), the app cannot flush before the response ends. There events arrive late (on a later request, or at `SIGTERM`), but they are not lost.

**Netlify Functions.** `context.waitUntil` exists since March 2025. This recipe is from Netlify's documentation and has not been tested:

<!-- recipe:netlify -->
```typescript
// netlify/functions/mcp.mts
import type { Context } from "@netlify/functions";

export default async (request: Request, context: Context): Promise<Response> =>
  analytics.flushWhenSent(await mcp.fetch(request), context);
```

A `withYavio()` host creates one `createYavio()` client at startup for the same key and endpoint, and calls its `flush()`, as for `shutdown()` above. The SDK needs `node:async_hooks`, `node:crypto`, `node:fs` and `node:os`, so runtimes without them (Vercel Edge, Netlify Edge) cannot load it.

## Captured data

Every call to a tool registered through the wrapped server produces one `tool_call` event with the tool name, latency, status and — subject to the `capture` flags — the inputs and the output. That holds when the tool asks the user for input over several rounds too: the event comes from the round whose result is final (see [Tools that ask for input](#tools-that-ask-for-input)). Task-based tools (MCP SDK v1's `experimental.tasks`) are the exception: they are not tracked (see [MCP 2026-07-28](#mcp-2026-07-28)).

Every event the SDK sends to `events` — `tool_call`, `connection`, `identify`, `step`, `track`, `conversion` — also carries `session_source`, how its `session_id` was derived: `mcp_session_id`, `openai_session`, `vscode_conversation`, `codex_thread`, `custom` (your `sessionKey`), `connection` (no key, not HTTP) or `per_request` (no key on an HTTP request) — see [Sessions](#stateless--per-request-servers). It names a source, never a key, and is recorded whatever the `capture` flags. The React widget stamps its server session's source on its own events too (from `_meta.yavio.sessionSource`). `tool_discovery` carries none: ingest writes it to the tool registry, which keeps no session fields. Events from SDKs before 0.5.4, server or widget, have none.

### Status and errors

A call is an error when the handler **throws** or when it **returns a result with `isError: true`** — the flag MCP uses to report tool failures to the model. Both count toward the dashboard's error rate; the `error_category` tells them apart:

| `status` | `error_category` | Meaning |
|----------|------------------|---------|
| `success` | — | The handler returned a result without `isError: true` |
| `error` | `tool_error` | The handler returned a result with `isError: true` (an expired reference, an invalid postal code, a missing field) |
| `error` | `unknown` | The handler threw |
| `error` | `validation` | The call failed **before** the handler ran: unknown or disabled tool, or arguments the tool's schema rejected. No `latency_ms` (nothing executed). By default the event has the names and types (`input_keys`, `input_types`) of the parameters the tool's schema declares, the `_`-prefixed request context in `input_values`, the client metadata and a value-free reason in `error_message` (McpServer's text as-is when it names only the tool — unknown, disabled — otherwise a fixed "Input validation error" reason), but **no argument values**, no key the model invented and no `output_content`. `rejectedInputValues: true` stores the raw arguments and McpServer's error text, to see what the model sent |
| `error` | `server` | The handler returned, but its result failed the tool's own `outputSchema` — or the MCP SDK's validation of the result on the wire. Also a call whose handler asked for input that the MCP SDK could not get or refused: v2's 2025-era shim with no channel to the client, a capability the client did not declare, a failed or timed-out answer; on MCP 2026-07-28 an input request the client's declared capabilities do not cover; on both eras a refused `requestState`, or a tool disabled, removed or changed between the rounds (see [Tools that ask for input](#tools-that-ask-for-input)) |

Only the literal boolean `true` counts as `isError`. On v1 the client sees the same shape in all four error cases (the MCP SDK converts throws and pre-handler failures into `isError` results), so the distinction is server-side only. On v2 an unknown or disabled tool is a thrown JSON-RPC error instead of an `isError` result; it is still counted as `validation` (`server` on a 2026-07-28 retry, whose handler ran in an earlier round).

Every `tools/call` request the wrapped server receives is counted, including the ones the MCP SDK rejects before your handler runs — a call to a tool name that does not exist shows up as that name with a 100 % error rate, which is the honest signal. Under `withYavio()` a tool registered on the original, unwrapped server stays untracked either way; `createYavio().wrap()` instruments every tool on the server (see [Stateless / per-request servers](#stateless--per-request-servers)). A task-based tool stays untracked under both, its refused calls included (see [MCP 2026-07-28](#mcp-2026-07-28)).

`error_message` is the exception's message, or for an `isError` result the first `text` content item. Both are PII-stripped and clamped to 500 characters. The result text is output, so it is stored only while `outputValues` is on. A thrown message is developer-written, but messages routinely interpolate the arguments (`no contract ${contractNo} for ${name}`) and the PII stripper does not recognise names or customer and contract numbers (it does catch an IBAN with valid check digits), so it is stored only while `inputValues` is on. `status` and `error_category` are recorded regardless.

Before 0.4.0 only a throw counted, so **error rates rise on upgrade** — a correction of an under-count, not a regression.

### Tools that ask for input

A tool on MCP SDK v2 can ask the user for input (an elicitation, a sampling call, the client's roots) by returning `inputRequired(...)`, a result with `resultType: "input_required"`. The handler then runs once per round: on MCP 2026-07-28 the client answers and retries the call as a new request, on the 2025 era v2's legacy shim (on by default) asks the client itself and runs the handler again inside the same request. Either way it is **one** `tool_call` event, from the round whose result is final: that round's output and status, and a failure after it (a failed `outputSchema`) lands on that event. A round that asked for input sends no event, and its result goes to the client exactly as the handler built it — no `_meta.yavio`, also without `serverOnly`. Since 0.5.5; before, every round was an event of its own.

`metadata` marks such a call (an ordinary call has none of these keys):

| Key | Meaning |
|-----|---------|
| `input_rounds` | How many times the handler returned `input_required` inside this request before the result that went out. Exact on the 2025 shim, where every round runs inside one request. `1` also when v2 refuses a 2026-07-28 round's input request |
| `input_retry` | `true`: the request is the client's 2026-07-28 retry. The earlier rounds were separate requests, possibly on another server instance, and are in no event |

An MCP SDK v2 tool call asked for input when `input_rounds > 0` or `input_retry` is true. `latency_ms` is the handler time of the rounds inside the request, never the time the user took to answer: on the 2025 shim every round's (a 40 ms round that asks plus a 20 ms final round is 60 ms), on 2026-07-28 the final request's only.

What the SDK cannot see:

- **A 2026-07-28 call whose client never retries** leaves no `tool_call`: the server cannot tell an abandoned call from one not retried yet. The session's `connection` event still exists.
- **The earlier rounds of a 2026-07-28 call:** their number and handler time are in no event, and a `yavio.track()` / `step()` / `conversion()` inside one carries that request's `trace_id`, which no `tool_call` has. On the 2025 shim every round shares the call's trace.
- **A decline:** the tool's own final result decides the `status`, as for any call.

The handler runs from the top in every round, so a `yavio.track()` / `step()` / `conversion()` placed before the input check fires once per round (two rounds, two `track` events, one `tool_call`). Put such calls in the branch that runs once, such as the one that returns the final result.

If v2 cannot get the input — the shim has no channel to the client (a per-request host serving a 2025-era client), the client did not declare the capability, the answer failed or timed out, too many rounds; on 2026-07-28 an input request the request's declared capabilities do not cover — the call is one `error` / `server` event, with the handler time of the rounds that ran. The same holds, on both eras, when v2 refuses a round's `requestState` (`Invalid or expired requestState`: your `requestState.verify` hook threw, say for a signed state past its expiry). So does a tool that was disabled, removed or changed its schema between the rounds (a fleet mid-deploy): `server` on both eras, not `validation`, because the handler ran in an earlier round. On 2026-07-28 these refusals come before the handler of the retry request, so the event has no `latency_ms` and stores the retry's arguments like a rejected call's (see `rejectedInputValues`), marked `input_retry`. A URL elicitation thrown in a later shim round sends nothing, as a URL elicitation always does: the client retries the call after the URL flow, and that call is recorded.

### Inputs

With `inputValues` on, `input_values` holds the tool's arguments plus a few fields from the MCP request context under `_`-prefixed keys (so they cannot collide with an argument), and the event carries the client metadata the platform relays in the request `_meta` as first-class fields: `locale`, `end_user_agent`, `subject_id` and — with `geo` on — `country_code`, plus `region` (state or province) with `geo: true` or `"region"`. A valid W3C `traceparent` goes to `metadata.traceparent` under the same flag (see [Trace context](#trace-context)).

| Key | Content |
|-----|---------|
| `_meta` | The request `_meta` verbatim. On ChatGPT that is `openai/userAgent`, `openai/locale`, `openai/userLocation` (city, region, country, timezone, **latitude and longitude**), `openai/subject` (the platform's stable pseudonymous user id), `openai/session` and the client's capabilities. ChatGPT also sends the IANA `timezone` at the top level. It intentionally duplicates the first-class `locale` / `end_user_agent` / `subject_id` / `country_code` / `region` fields. With `geo: "region"` the location object is reduced to `{ country, region }`, with `geo: "country"` to `{ country }`, and with `geo: false` it is removed entirely. In all three, the rest of `_meta` keeps only `openai/locale`, `openai/userAgent`, `openai/subject` and `openai/session` (the last not with `conversationId: false`); everything else is dropped — the top-level `timezone` and `timezone_offset_minutes`, the conversation and request ids (`sessionId`, `windowId`, `callId`, `itemId`, `openai/request_id`), `openai/organization`, the client capabilities, and any key the platform adds later. With `conversationId: false` (since 0.5.6) the platform's raw conversation ids are removed under every `geo`, `true` included, and only their names recorded in `_metaDroppedKeys`: ChatGPT's `openai/session` and its top-level `sessionId` and `windowId`, VS Code's `vscode.conversationId`, and `threadId` from any client (see [Conversation ids](#conversation-ids)). Under every `geo`, `true` included, the trace context never stays (since 0.5.5, before which `geo: true` kept it verbatim): the W3C keys of MCP 2026-07-28 (SEP-414) `baggage` (free-form context the client's upstream services attach, often user or tenant ids) and `tracestate` (vendor trace state), .NET's `Correlation-Context` (baggage, as .NET 8 and 9 send it) and Datadog's `_dd_trace_context` (the object its MCP instrumentation fills with Datadog's ids and tags, a `tracestate` and the baggage), each in any letter case, are dropped and only their key names recorded in `_metaDroppedKeys` (a `traceparent` that is invalid or not spelled in lower case likewise); keys that carry one baggage member each, Jaeger's `uberctx-…` and OpenTracing's `ot-baggage-…`, are dropped and only counted in `_metaDroppedUnnamed`, because their names are the members' names; a valid `traceparent` moves to `metadata.traceparent` (see [Trace context](#trace-context)) |
| `_metaDroppedKeys` / `_metaDroppedUnnamed` | The names (never the values) of the `_meta` keys that were dropped, sorted, at most 20 — with `geo` other than `true` every key outside the allowlist, so a key the platform adds shows up in your data; with `geo: true` only the trace-context keys above (since 0.5.5) and, with `conversationId: false`, the conversation keys that were sent — and the number of dropped keys it does not name (a name with a run of 8 or more hex digits, which can carry an id, a malformed name, one past the 20, or a per-key baggage carrier such as `uberctx-user.id`) |
| `_taskId` | MCP SDK v1 only: the id of the task a tracked call names as related, `_meta["io.modelcontextprotocol/related-task"].taskId`. Task-based tools themselves are not tracked (see [MCP 2026-07-28](#mcp-2026-07-28)) |
| `_requestInfo` | The calling request's `user-agent`, `accept-language`, `x-anthropic-client` and `mcp-protocol-version` headers, plus its URL without the query string. A valid `traceparent` header is `metadata.traceparent` since 0.5.5; `tracestate` and `baggage` headers were never kept. Every other header is dropped — `Authorization`, `Cookie`, `X-Api-Key` and the like never reach analytics, and no `X-Forwarded-For` means an event stays free of end-user IPs |

The `connection` event's `client_name` / `client_version` — captured whatever the flags, like the `initialize` clientInfo always was — come from the protocol envelope (MCP 2026-07-28), else from the `initialize` handshake, else from the first product token of the request's `User-Agent`: `name/version` with at least one digit in the version (`openai-mcp/1.0.0` → `openai-mcp`, `1.0.0`; `OpenAI/Python 1.40.0` names no client), or a bare `name` when that is the whole User-Agent (`Claude-User` → `Claude-User`, no version). The name is accepted only for a known MCP client: a vendor the SDK's platform matcher recognises (`openai-mcp`, `Claude-User`, `claude-code`, `cursor`, `gemini-cli`, …) or an allowlisted token (`mcp-inspector`, `mcp-remote`). Every other first token names no client — a bare first word followed by more (`node …`, the `Visual` of `Visual Studio Code/1.95`), a library, runtime, browser or server-framework token (`node`, `python-httpx/0.27`, `Python/3.12 aiohttp/3.9.5`, `Java-http-client/17.0.2`, `Mozilla/5.0 …`, `Nitro/2.9.0`, `Hono/4.6.0`), and a client the SDK does not know yet — so an unrecognised name never reaches the 13-month client statistics, which are not recomputed once the raw events age out. Only the parsed name and version are stored; `metadata.client_info_source` says which source it was, because a stateless host records the User-Agent's name where a long-lived one records the handshake's (Codex driven through ChatGPT is `openai-mcp` on one and `codex-mcp-client` on the other). `protocol_version` comes from the MCP 2026-07-28 request envelope, else the request's `mcp-protocol-version` header, else the version the server answered `initialize` with, so stdio and in-memory connections have it too (since 0.5.5; before, it was the header alone, and unset off HTTP); only the protocol's date shape (`2025-06-18`) is stored. `metadata.client_capabilities` lists the names of the capabilities the client declared (`elicitation`, `roots`, `sampling`, `tasks`, …), never their values: from the 2026-07-28 envelope, else from the `initialize` handshake, sorted, at most 20 (since 0.5.5); a name outside the MCP key format, or with a run of 8 or more hex digits, which can carry an id, is left out, as in `_metaDroppedKeys`. It is absent when the client declared none, and on a per-request host serving a 2025-era client, whose server instance never saw `initialize`. Key-less HTTP calls send one `connection` event per process per client, so it holds the first caller's list; on an MCP SDK v1 1.24/1.25 server that reuses one stateless transport, a list from the handshake is the last client's to initialize, as is a client name from the handshake. Like the client name, both are recorded whatever the `capture` flags.

**Disclose this.** With the defaults, every tool call from ChatGPT stores the user's approximate position including coordinates and the platform's stable user id. Name that collection in your privacy policy, or set `geo: "region"` (keeps the country and the state or province), `geo: "country"` (keeps only the country) or `geo: false` (no location), or `inputValues: false` (drops all of it; also per tool, see above). With `"region"`, `"country"` or `false`, the captured `_meta` holds four keys, or three with `conversationId: false`: `openai/locale`, `openai/userAgent`, `openai/subject` and `openai/session` — language, device, and the platform's pseudonymous user and conversation ids — plus the location the setting allows; every other key is dropped and only its name is recorded in `_metaDroppedKeys`. The request headers stay as listed under `_requestInfo` (user agent, `accept-language`, `x-anthropic-client`, protocol version). No `baggage`, `tracestate`, `Correlation-Context` or `_dd_trace_context` (in any letter case) and no `uberctx-…` or `ot-baggage-…` key is stored under any setting, and a valid `traceparent` is kept as `metadata.traceparent` (since 0.5.5; before, `geo: true` stored the request's `baggage` verbatim, whatever the client's upstream had put into it). Before 0.4.1, `"country"` and `false` still kept ChatGPT's top-level `timezone` and every other `_meta` key. Note that in city-states the region *is* the city: ChatGPT reports Berlin as `State of Berlin`, and the same goes for Hamburg, Bremen, Vienna or Washington, D.C. A region name with digits or `@` is dropped, so a postal code cannot pass as one. The React widget is separate from all of this: its `widget_render` event stores the browser's time zone regardless of `capture.geo` (only when you run the widget SDK, i.e. without `serverOnly`).

**Rejected arguments are not stored by default.** A successful call only ever stores values its schema accepted, so a tool whose arguments are all enums stores only those fixed values. A call the schema rejects would otherwise store whatever the model put into the field, free text from the conversation included. With `rejectedInputValues: false`, the default, such a call keeps only the names and types of the parameters the tool's schema declares, plus a value-free reason. No value and no key the model invented is stored. Set `rejectedInputValues: true` (globally or per tool) only if you want to see the values the model sent, and disclose it.

All captured input and output is PII-stripped before it leaves the process, but the stripper matches only these shapes:

- email addresses;
- IBANs with valid check digits (mod 97);
- card numbers: 13 to 19 digits, optionally separated by spaces or dashes, that pass the Luhn check (some 19-digit groupings and groupings with other spaces, such as `4111 11111111 1111` with no-break spaces, are missed, #190); and any 16 digits in a row, Luhn or not, since a card number with one mistyped digit fails the check (a mistyped card in groups, `4111 1111 1111 1112`, is not matched);
- US Social Security numbers in the dashed form `123-45-6789` (the ingestion API also takes `123 45 6789`, the bare nine digits and ITINs; #193);
- phone numbers in groups of 3 or 4 (or 5 starting with a trunk `0`, `07141 1234567`), then 3, then 4 digits, each optionally separated by `-`, `.` or whitespace, the first group optionally in parentheses, with an optional `+CC` or `00CC` and `(0)` in front: the US formats (`(555) 123-4567`, `555.123.4567`, `+1 555 123 4567`) and the international numbers of that shape (`+49 171 1234567`, `0171-1234567`, `(0171) 1234567`, `+49 (0)171 1234567`, `0049 171 1234567`); and a run of 12 to 15 digits that does not start with 1 (`491711234567`).

Other phone groupings are not matched: `030 12345678`, `+33 6 12 34 56 78`, `0171 123 45 67`, `07700 900 123`, a `/` between the groups, extensions (#189). Some values that are not personal data are redacted: a standalone 10-digit number such as an epoch second or `ORD-2026-1234567890` (#192), a 12-to-15-digit number that does not start with 1 such as an EAN-13, any 16 digits in a row such as an epoch in microseconds or an order number (`0012345678901234` included), a Luhn-valid 13-to-19-digit number, also glued to a word or `_` (`ref_4111-1111-1111-1111`, `deadbeef4111111111111111`), the rare hex id that passes the IBAN check (#191), a fully separated SSN glued to a word (`XBG109-09-1527`), and a number glued to a word right after an escape, such as an encoded path segment (`%2Fuser1234567890`, cut like `/user1234567890`). A number must not touch a letter or digit on either side, so ids keep their digits (`order5551234567x`, `deadbeef5551234567`). The exceptions: a number right after a URL percent-escape (also a double-encoded one, `%252B…`), a JSON `\uXXXX` escape or a JSON `\b` `\f` `\n` `\r` `\t` escape (`?phone=%2B4917612345678`, `Pay%20with%204111111111111111`, `"Tel.\u00a00171 1234567"`, `"Jane\f5551234567"`); a number right after a word of up to 24 letters that has a letter outside a–f, also when that word follows an escape (`Tel5551234567`, `Call%20me%20at%20Tel5551234567`); a number right after a word of letters a–f only when the number has a phone's shape: a `+`, a `(` or a separator after its first 2 to 4 digits or after a 5-digit group starting with `0` (`cafe555-123-4567`, `cafe07141 1234567`); and a Luhn-valid card number after any word of letters (`cafe4367063062371650`). Still not redacted, as the price of not cutting hex ids: a phone number glued to an a–f word without that shape (`cafe5551234567`) and a Luhn-invalid 16-digit run glued to one (`cafe4111111111111112`), a number glued to a token of letters and digits or to a word of more than 24 letters. A phone number can take an escape's own digits with it (`Call%20me%20at%205551234567` becomes `Call%20me%20at%[PHONE_REDACTED]`): the escape is cut, nothing of the number is left. A card number can do the same: when a Luhn-valid run starts inside an escape, the card's last group stays (`"Card\u00204799 56605796 5730"` becomes `"Card\u[CC_REDACTED] 5730"`, where before 0.5.6 `4799 56` stayed; `Card%3A%205555-5555-5555-4444` becomes `Card%3A%[CC_REDACTED]-4444`, as before). In ingest, an SSN or ITIN with one separator or none (`123-456789`, `123456789`) is only matched standing alone, as before #182; after a `\u00a0`-style escape that ends in a digit it is no longer redacted (`"SSN\u00a0912345678"`), where before 0.5.6 the phone pattern caught it by taking the escape's last digit. UUIDs and traceparent-shaped values standing alone (not glued to a letter or digit, or right after an escape) are not cut, in any letter case, on the server and in browsers with regex lookbehind (since 0.5.6, #182; before, the phone and card patterns cut the digits of about 1.8 % of random UUIDs and 0.9 % of hex ids); the fallback on Safari and iOS before 16.4 cuts them as 0.5.5 did (see [React Widget](#react-widget)). A glued one is not masked (`x21165216-7349-…` becomes `x[CC_REDACTED]-981e-…`), and an all-digit short hex id is a number like any other. A string that is exactly a valid `traceparent` is left as it is (since 0.5.5). The ingestion API strips every event again with the same rules plus its own (the SSN forms above, US street addresses); it cannot restore digits an SDK before 0.5.6 already replaced.

### Trace context

A valid W3C `traceparent` is stored once, as the `tool_call`'s `metadata.traceparent`: `version-traceid-parentid-flags` in lower-case hex (2, 32, 16 and 2 digits, 55 characters in all), a version other than `ff`, neither id all zeros. It comes from the request `_meta` (MCP 2026-07-28, SEP-414; the only carrier on stdio), else from the HTTP `traceparent` header, else from Datadog's `_meta._dd_trace_context.traceparent`: the `_meta` value is what the MCP client attached to this request, a header can be any HTTP hop's. Anything else under that name is not stored: upper case, padding, a repeated header, a future version with extra fields. It is captured under `inputValues` like the client metadata (also [per tool](#per-tool-overrides)), with every `geo`, for tools without arguments too, and whatever the call's outcome, a rejected call included. Use it to join a call to your own traces: `JSONExtractString(metadata, 'traceparent')`; the trace id is its second field, `splitByChar('-', JSONExtractString(metadata, 'traceparent'))[2]`. `tracestate`, `baggage`, `Correlation-Context` and `_dd_trace_context` are never stored, only their `_meta` key names in `_metaDroppedKeys`, and the per-key baggage carriers (`uberctx-…`, `ot-baggage-…`) only as a count in `_metaDroppedUnnamed`. Other vendors' propagation keys (Sentry's `sentry-trace`, B3's `b3`, Jaeger's `uber-trace-id`) are ids, not baggage, and are treated like any other `_meta` key.

Since 0.5.5. Before, the header was in `_requestInfo` (as sent, any text), `geo: true` also kept the `_meta` copy, any other `geo` dropped it (so a stdio server stored none), and the PII stripper cut about 1.9 % of them: an id ending in ten decimal digits looked like a phone number to it. The ingestion API's stripper leaves a valid one alone too; an ingest deployed before that change still cuts those 1.9 %. Until 0.5.6, a traceparent inside text or in upper case was still cut that way; since then, no traceparent-shaped value is (#182). Rows stored before keep `input_values._meta.baggage` / `tracestate` until the 13-month TTL; nothing is backfilled.

### Conversation ids

The platform's conversation id is stored twice by default: hashed, as `session_id`, and raw, in `_meta` — `openai/session` under every `geo`, and with `geo: true` also ChatGPT's top-level `sessionId` and `windowId`, VS Code's `vscode.conversationId` and the Codex CLI's `threadId`. The raw copies add no metric: the dashboard reads sessions only from `session_id`. Set `capture.conversationId: false` (since 0.5.6) to remove them from `_meta` under every `geo`; only their names are recorded in `_metaDroppedKeys`. `threadId` is removed whichever client sent it. `session_id`, `session_source` and every session metric stay the same, and your handler still receives the full `_meta`. `session_id` is pseudonymous, not anonymous: it is derived from an unkeyed SHA-256 of the raw id, so whoever holds the raw id, such as the platform or your own logs, can compute it again. The flag works forward only: events stored before you set it keep their raw ids until the 13-month TTL, and removing them from stored events is an operator task. It is global, with no per-tool override, because one conversation would otherwise be split into rows with the id and rows without it; a per-tool `inputValues: false` removes all of `_meta` for that tool. It covers neither the user id (`openai/subject`, which is also the first-class `subject_id`) nor the per-call ids (`callId`, `itemId`, `openai/request_id`), which are dropped under every `geo` but `true`.

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

The widget strips traits and event properties with the same PII rules as the server (see [Captured data](#captured-data)). On browsers without regex lookbehind (Safari and iOS before 16.4) the widget uses the previous patterns (those of 0.5.5): it still loads and redacts as much as before, but cuts digits out of ids as 0.5.5 did.

## PII Protection

Email addresses, credit card numbers, SSNs, and phone numbers are automatically stripped from event payloads before they leave the client.

## Documentation

Full documentation is available at [docs.yavio.ai](https://docs.yavio.ai/docs).

## License

[MIT](./LICENSE)
