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
 * `shutdownTimeoutMs: 1_500` — or RECIPE_SHUTDOWN_TIMEOUT_MS — and on
 * stdin's end await `analytics.shutdown()`, then exit) | "handle" (a handle of the
 * app's outlives the EOF by 1 s, so the client's `SIGTERM` arrives while the
 * SDK's natural-exit drain runs) | "sigint" (an app `SIGINT` listener that
 * only prints `[fixture] SIGINT` to stderr: the process survives the SDK's
 * hand-back and serves the calls that follow, #174) | "stdin-end-with" (the
 * README's stdio recipe next to `withYavio()`: the servers wrapped with
 * `withYavio()` on both stacks, a shutdown-only `createYavio()` client on the
 * same key with RECIPE_SHUTDOWN_TIMEOUT_MS or 1 500, and on stdin's end
 * await its `shutdown()`, then exit, #179) | "stdin-end-with-noexit" (the
 * same without `process.exit()`: prints `[fixture] shutdown resolved` to
 * stderr, and the process ends once nothing keeps it alive, #179); INTENT =
 * "1" turns intent capture on and adds `widget_echo`, a widget-invoked
 * tool, so every informational line the SDK has is printed (#174);
 * SIGNAL_PROBE = "1" prints `[fixture] <signal> <Date.now()>` to stderr
 * when Node dispatches a SIGINT or SIGTERM, before any listener runs —
 * through `process.emit`, so no listener is added and the SDK still sees
 * itself as the only one (#175).
 *
 * stdout is the MCP wire: nothing here writes to it, and the SDK must not
 * either (#174) — so this fixture leaves `console` as it is.
 */
import { writeSync } from "node:fs";
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
  // The README's stdio recipe: its shutdown() ends before the client's
  // SIGTERM at 2 s. RECIPE_SHUTDOWN_TIMEOUT_MS lowers it for a test that
  // needs a wider margin on a loaded host.
  ...(mode === "stdin-end"
    ? { shutdownTimeoutMs: Number(process.env.RECIPE_SHUTDOWN_TIMEOUT_MS ?? 1_500) }
    : {}),
};
const echo = async ({ q }: { q: string }) => ({ content: [{ type: "text" as const, text: q }] });
/** Marks a tool as one the widget calls: with intent required, the SDK logs that it advertises `context` as optional there. */
const widgetMeta = { "openai/widgetAccessible": true };
/** #179: the README's stdio recipe next to `withYavio()`. */
const pinnedRecipe = mode === "stdin-end-with" || mode === "stdin-end-with-noexit";

if (process.env.SIGNAL_PROBE === "1") {
  // Node dispatches a signal through `process.emit(name, name)`: wrapping
  // it reports the dispatch without adding a listener of the app's.
  const emit = process.emit.bind(process) as (event: string, ...args: unknown[]) => boolean;
  (process as { emit: unknown }).emit = (event: string, ...args: unknown[]): boolean => {
    if (event === "SIGINT" || event === "SIGTERM") {
      writeSync(2, `[fixture] ${event} ${Date.now()}\n`);
    }
    return emit(event, ...args);
  };
}

let analytics: ReturnType<typeof createYavio> | undefined;
if (pinnedRecipe) {
  // Once, at startup, for the same key: shutdown() only.
  analytics = createYavio({
    ...options,
    shutdownTimeoutMs: Number(process.env.RECIPE_SHUTDOWN_TIMEOUT_MS ?? 1_500),
  });
  // Wrapped first: withYavio() tracks the tools registered through its proxy.
  if (stack === "v2") {
    serveStdio(() => {
      const server = withYavio(new McpServerV2({ name: "child", version: "1.0.0" }), options);
      server.registerTool("echo", { description: "Echo", inputSchema: { q: z.string() } }, echo);
      return server;
    });
  } else {
    const server = withYavio(new McpServerV1({ name: "child", version: "1.0.0" }), options);
    server.registerTool("echo", { description: "Echo", inputSchema: { q: z.string() } }, echo);
    await server.connect(new StdioServerTransport());
  }
} else if (stack === "v2") {
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

if (mode === "stdin-end" || mode === "stdin-end-with") {
  process.stdin.on("end", async () => {
    await analytics?.shutdown();
    process.exit(0);
  });
}
if (mode === "stdin-end-with-noexit") {
  process.stdin.on("end", async () => {
    await analytics?.shutdown();
    writeSync(2, "[fixture] shutdown resolved\n");
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
