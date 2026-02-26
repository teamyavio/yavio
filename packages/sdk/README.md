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
  capture: {
    inputValues: true,   // capture tool input values (default: true)
    outputValues: true,  // capture tool output values (default: true)
    geo: true,           // capture geo data (default: true)
    tokens: true,        // capture token counts (default: true)
    retries: true,       // capture retry attempts (default: true)
  },
});
```

## Tracking API

Import `yavio` and call methods inside tool handlers — context is propagated automatically:

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
