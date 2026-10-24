/**
 * The child of `stdio-process.test.ts` (#167, #174): a stdio MCP server
 * written as the MCP SDKs' own examples write it — no shutdown code of its
 * own — run as its own process and ended the MCP stdio way by the real
 * `StdioClientTransport`: it closes the server's stdin, sends `SIGTERM` 2 s
 * later and `SIGKILL` 2 s after that. Started with `node --import tsx`
 * against the SDK's source.
 *
 * Env: ENDPOINT (the mock ingest); STACK = "v1" (`StdioServerTransport` and
 * `withYavio()`) | "v2" (`serveStdio` and `createYavio().wrap()`); MODE =
 * "plain" (nothing else: the process ends when stdin does) | "stdin-end"
 * (the README's recipe for a server with handles of its own:
 * `shutdownTimeoutMs: 1_500`, and on stdin's end await
 * `analytics.shutdown()`, then exit) | "handle" (a handle of the
 * app's outlives the EOF by 1 s, so the client's `SIGTERM` arrives while the
 * SDK's natural-exit drain runs) | "sigint" (an app `SIGINT` listener that
 * only prints `[fixture] SIGINT` to stderr: the process survives the SDK's
 * hand-back and serves the calls that follow, #174); INTENT = "1" turns
 * intent capture on and adds `widget_echo`, a widget-invoked tool, so every
 * informational line the SDK has is printed (#174).
 *
 * stdout is the MCP wire: nothing here writes to it, and the SDK must not
 * either (#174) — so this fixture leaves `console` as it is.
 */
import { McpServer as McpServerV1 } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer as McpServerV2 } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { createYavio, withYavio } from "../../../server/index.js";

const endpoint = process.env.ENDPOINT;
if (!endpoint) throw new Error("ENDPOINT is not set");
const stack = process.env.STACK ?? "v1";
const mode = process.env.MODE ?? "plain";
const intent = process.env.INTENT === "1";
const options = {
  apiKey: "yav_stdio_child",
  endpoint,
  serverOnly: true,
  intent,
  // The README's stdio recipe: its shutdown() ends before the client's SIGTERM at 2 s.
  ...(mode === "stdin-end" ? { shutdownTimeoutMs: 1_500 } : {}),
};
const echo = async ({ q }: { q: string }) => ({ content: [{ type: "text" as const, text: q }] });
/** Marks a tool as one the widget calls: with intent required, the SDK logs that it advertises `context` as optional there. */
const widgetMeta = { "openai/widgetAccessible": true };

let analytics: ReturnType<typeof createYavio> | undefined;
if (stack === "v2") {
  analytics = createYavio(options);
  const client = analytics;
  serveStdio(() => {
    const server = new McpServerV2({ name: "child", version: "1.0.0" });
    server.registerTool("echo", { description: "Echo", inputSchema: { q: z.string() } }, echo);
    if (intent) {
      server.registerTool(
        "widget_echo",
        { description: "Echo for the widget", inputSchema: { q: z.string() }, _meta: widgetMeta },
        echo,
      );
    }
    return client.wrap(server);
  });
} else {
  if (mode === "stdin-end") analytics = createYavio(options);
  const server = analytics
    ? analytics.wrap(new McpServerV1({ name: "child", version: "1.0.0" }))
    : withYavio(new McpServerV1({ name: "child", version: "1.0.0" }), options);
  server.registerTool("echo", { description: "Echo", inputSchema: { q: z.string() } }, echo);
  if (intent) {
    server.registerTool(
      "widget_echo",
      { description: "Echo for the widget", inputSchema: { q: z.string() }, _meta: widgetMeta },
      echo,
    );
  }
  await server.connect(new StdioServerTransport());
}

if (mode === "stdin-end") {
  process.stdin.on("end", async () => {
    await analytics?.shutdown();
    process.exit(0);
  });
}
if (mode === "handle") {
  process.stdin.on("end", () => {
    setTimeout(() => {}, 1_000);
  });
}
if (mode === "sigint") {
  process.on("SIGINT", () => {
    process.stderr.write("[fixture] SIGINT\n");
  });
}
