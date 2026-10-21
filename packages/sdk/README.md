# @yavio/sdk

Instrument [MCP](https://modelcontextprotocol.io/) servers with analytics, session tracking, and an optional React widget — all in one line of code.

## Install

```bash
npm install @yavio/sdk
```

Works with either MCP SDK generation, installed as an optional peer dependency: `@modelcontextprotocol/sdk` >=1.24.0 (v1) or `@modelcontextprotocol/server` 2.x (v2, the scoped package family). CI tests the v1 floor, the latest v1 release and the latest v2 release weekly.

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
2. Environment variables `YAVIO_API_KEY` and `YAVIO_ENDPOINT`
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

What holds across instances: the same `session_id` and user for the same conversation (`Mcp-Session-Id` or ChatGPT's `openai/session`), one `connection` event per session, one `tool_discovery` per tool per project per process, and `yavio.identify()` on one request visible on the next. A client that sends neither session key gets one session per request. Widget tokens are minted per tool call in non-serverOnly mode, as the ingest contract requires (a token is bound to the trace of the call that minted it); the mint is bounded by a 2 s timeout, after which the result goes out without `_meta.yavio`.

`wrap()` instruments **every tool on the server**, including the ones `buildServer()` registered before the wrap. That is the one behavioural difference to `withYavio()`, which tracks only the tools registered through the proxy it returns — a tool kept on the raw server on purpose stays untracked under `withYavio()`, and the way to limit capture for a sensitive tool under either entry point is the `tools` overrides.

`withYavio(server, options)` is safe for a server created per request too: the transport, the session store and the shutdown hooks are shared per API key and endpoint. It resolves the configuration (environment, `.yaviorc.json`) on every call, which `createYavio()` does once. Wrapping the same long-lived server again — with either entry point — returns the existing proxy, so a host that wraps on every request never stacks instrumentation. The first wrap wins: later options are ignored — any difference (another key or endpoint, other `capture` flags or `tools` overrides, `serverOnly`, intent, or a `wrap()` after a `withYavio()`) logs one `YAVIO-1108` warning and the first wrap's configuration keeps applying.

`analytics.shutdown()` drains (bounded by the transport's 10 s shutdown timeout) and releases this client's hold on the shared transport, for hosts with their own lifecycle; the transport stops once no client with the same key holds it (a `withYavio()` call never releases). The SDK also drains everything on `SIGTERM`/`SIGINT`. A `401` from ingest stops delivery for that key process-wide (`YAVIO-1203`): every wrap sharing the key is affected, which is what an invalid key means.

A value that is not an `McpServer` (no `registerTool()` / `connect()`) comes back unwrapped with one `YAVIO-1107` error per process — in no-op mode too — so a mis-wired integration keeps serving. After `SIGTERM`/`SIGINT` the SDK drains every transport; requests still served during the graceful-shutdown window send their events at once, best effort.

## Captured data

Every call to a tool registered through the wrapped server produces one `tool_call` event with the tool name, latency, status and — subject to the `capture` flags — the inputs and the output.

### Status and errors

A call is an error when the handler **throws** or when it **returns a result with `isError: true`** — the flag MCP uses to report tool failures to the model. Both count toward the dashboard's error rate; the `error_category` tells them apart:

| `status` | `error_category` | Meaning |
|----------|------------------|---------|
| `success` | — | The handler returned a result without `isError: true` |
| `error` | `tool_error` | The handler returned a result with `isError: true` (an expired reference, an invalid postal code, a missing field) |
| `error` | `unknown` | The handler threw |
| `error` | `validation` | The call failed **before** the handler ran: unknown or disabled tool, or arguments the tool's schema rejected. No `latency_ms` (nothing executed). By default the event has the names and types (`input_keys`, `input_types`) of the parameters the tool's schema declares, the `_`-prefixed request context in `input_values`, the client metadata and a value-free reason in `error_message` (McpServer's text as-is when it names only the tool — unknown, disabled — otherwise a fixed "Input validation error" reason), but **no argument values**, no key the model invented and no `output_content`. `rejectedInputValues: true` stores the raw arguments and McpServer's error text, to see what the model sent |
| `error` | `server` | The handler returned, but its result failed the tool's own `outputSchema` |

Only the literal boolean `true` counts as `isError`. The client sees the same shape in all four error cases (the MCP SDK converts throws and pre-handler failures into `isError` results), so the distinction is server-side only.

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

**Disclose this.** With the defaults, every tool call from ChatGPT stores the user's approximate position including coordinates and the platform's stable user id. Name that collection in your privacy policy, or set `geo: "region"` (keeps the country and the state or province), `geo: "country"` (keeps only the country) or `geo: false` (no location), or `inputValues: false` (drops all of it; also per tool, see above). With `"region"`, `"country"` or `false`, the captured `_meta` holds exactly `openai/locale`, `openai/userAgent`, `openai/subject` and `openai/session` — language, device, and the platform's pseudonymous user and conversation ids — plus the location the setting allows; every other key is dropped and only its name is recorded in `_metaDroppedKeys`. The request headers stay as listed under `_requestInfo` (user agent, `accept-language`, `x-anthropic-client`, protocol version, `traceparent`). Before 0.4.1, `"country"` and `false` still kept ChatGPT's top-level `timezone` and every other `_meta` key. Note that in city-states the region *is* the city: ChatGPT reports Berlin as `State of Berlin`, and the same goes for Hamburg, Bremen, Vienna or Washington, D.C. A region name with digits or `@` is dropped, so a postal code cannot pass as one. The React widget is separate from all of this: its `widget_render` event stores the browser's time zone regardless of `capture.geo` (only when you run the widget SDK, i.e. without `serverOnly`).

**Rejected arguments are not stored by default.** A successful call only ever stores values its schema accepted, so a tool whose arguments are all enums stores only those fixed values. A call the schema rejects would otherwise store whatever the model put into the field, free text from the conversation included. With `rejectedInputValues: false`, the default, such a call keeps only the names and types of the parameters the tool's schema declares, plus a value-free reason. No value and no key the model invented is stored. Set `rejectedInputValues: true` (globally or per tool) only if you want to see the values the model sent, and disclose it.

All captured input and output is PII-stripped before it leaves the process, but the stripper only matches emails, Luhn-valid card numbers, US Social Security numbers and US-format phone numbers.

## Tracking API

Import `yavio` and call methods inside tool handlers — context is propagated automatically. A call from outside a wrapped tool call has no session or trace to attach to: the event is dropped and the SDK warns once per process (`YAVIO-1105`). If that warning shows up, the tool is registered on the unwrapped server — move it onto the wrapped one and use `tools` overrides to limit what is captured for it.

```typescript
import { yavio } from "@yavio/sdk";

// Associate events with a user
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
