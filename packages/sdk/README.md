# @yavio/sdk

Instrument [MCP](https://modelcontextprotocol.io/) servers with analytics, session tracking, and an optional React widget — all in one line of code.

## Install

```bash
npm install @yavio/sdk
```

Requires `@modelcontextprotocol/sdk` >=1.0.0 as a peer dependency.

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
    geo: true,           // capture the country code (default: true)
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
| `inputValues` | No `input_keys`, `input_types`, `input_values` and no client metadata (`locale`, `country_code`, `end_user_agent`, `subject_id`) for this tool, on success and on error |
| `outputValues` | No `output_content`, and no `error_message` taken from an `isError` result (that text is output). `status` and `error_category` are still recorded; a thrown error's message still is |
| `intent` | The `context` parameter is neither advertised nor captured for this tool. A `context` a client still sends from a cached schema is stripped before validation, so strict schemas keep accepting the call. No effect while intent capture is off globally |

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

## Captured data

Every call to a tool registered through the wrapped server produces one `tool_call` event with the tool name, latency, status and — subject to the `capture` flags — the inputs and the output.

### Status and errors

A call is an error when the handler **throws** or when it **returns a result with `isError: true`** — the flag MCP uses to report tool failures to the model. Both count toward the dashboard's error rate; the `error_category` tells them apart:

| `status` | `error_category` | Meaning |
|----------|------------------|---------|
| `success` | — | The handler returned a result without `isError: true` |
| `error` | `tool_error` | The handler returned a result with `isError: true` (an expired reference, an invalid postal code, a missing field) |
| `error` | `unknown` | The handler threw |

Only the literal boolean `true` counts as `isError`. The client sees the same shape either way (the MCP SDK converts a throw into an `isError` result), so the distinction is server-side only.

`error_message` is the exception's message, or for an `isError` result the first `text` content item. Both are PII-stripped and clamped to 500 characters. The result text is output, so it is stored only while `outputValues` is on; `status` and `error_category` are derived from the result regardless of output capture.

Before 0.4.0 only a throw counted, so **error rates rise on upgrade** — a correction of an under-count, not a regression.

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
