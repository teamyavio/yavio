/**
 * The child of `signals-process.test.ts` (#142, #148): the README's stateless
 * host — a new McpServer per request wrapped by one `createYavio()` client —
 * run as its own process, so a real SIGTERM/SIGINT, the app's own handler
 * and `process.exit()` are what the test exercises. Started with
 * `node --import tsx` against the SDK's source.
 *
 * Env: ENDPOINT (the mock ingest); STACK = "v1" (MCP SDK v1 Streamable HTTP
 * over `node:http`, JSON responses) | "v2" (`createMcpHandler` +
 * `toNodeHandler`); MODE = "readme" (the README's recipe: a close bounded at
 * 3 s, then `shutdown()`, then exit 0, on both signals) | "none" (no handler
 * of its own: the SDK drains and hands the signal back, Node's default exit)
 * | "noexit" (the recipe without `process.exit()`: the process must exit on
 * its own once nothing keeps it alive; prints `shutdown resolved`) |
 * "none-stdin" (no handler, and nothing of the app's keeps the process
 * alive but stdin — a stdio server's shape: the listening socket is
 * unref'd, so once the test ends stdin only the SDK can hold the loop, #164)
 * | "idle" (no SIGTERM/SIGINT handler; SIGUSR2 closes the server and nothing
 * else — no signal, no `shutdown()`: the loop empties, and the SDK's
 * natural-exit drain delivers what is still queued within 1.5 s, or gives
 * it up there with one line, #167 — nothing of the SDK's keeps the process
 * alive past that, #164) | "pinned-cli" (a CLI or cron shape: a
 * `withYavio()` pin on the same key, and SIGUSR2 closes the server and
 * awaits `analytics.shutdown()` — no signal the SDK handles; the client's
 * shutdown stops the pinned key's transport (#179; it only drained it
 * before), and that stop must hold the process until its retry delivers,
 * or abort the fetch at its deadline; prints `shutdown resolved`, #164
 * review round 4). Prints `ready <port>` once listening
 * and `started <sku>` when the `slow` tool begins, so the test can send the
 * signal with that call in flight. `slow` with `track: true` also calls
 * `yavio.track()` before it returns: a request served after the signal
 * that sends two events (#154 review round 1).
 *
 * The block between `shutdown-recipe:start` and `shutdown-recipe:end` is the
 * README's recipe, byte for byte: a test compares the two.
 */
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { McpServer as McpServerV1 } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer as McpServerV2, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createYavio, withYavio, yavio } from "../../../server/index.js";

const endpoint = process.env.ENDPOINT;
if (!endpoint) throw new Error("ENDPOINT is not set");
const stack = process.env.STACK ?? "v1";
const mode = process.env.MODE ?? "readme";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Once per process.
const analytics = createYavio({ apiKey: "yav_child", endpoint, serverOnly: true });

const started = (sku: string) => process.stdout.write(`started ${sku}\n`); // the test waits for this before it sends the signal

function buildV1(): McpServerV1 {
  const server = new McpServerV1({ name: "child", version: "1.0.0" });
  server.registerTool(
    "get_price",
    { description: "Price of a SKU", inputSchema: { sku: z.string() } },
    async ({ sku }) => ({ content: [{ type: "text", text: `price of ${sku}` }] }),
  );
  server.registerTool(
    "slow",
    {
      description: "Takes a while",
      inputSchema: { sku: z.string(), ms: z.number(), track: z.boolean().optional() },
    },
    async ({ sku, ms, track }) => {
      started(sku);
      await sleep(ms);
      if (track) yavio.track("slow_done", { sku });
      return { content: [{ type: "text", text: `slow ${sku}` }] };
    },
  );
  return server;
}

function buildV2(): McpServerV2 {
  const server = new McpServerV2({ name: "child", version: "1.0.0" });
  server.registerTool(
    "get_price",
    { description: "Price of a SKU", inputSchema: { sku: z.string() } },
    async ({ sku }: { sku: string }) => ({
      content: [{ type: "text" as const, text: `price of ${sku}` }],
    }),
  );
  server.registerTool(
    "slow",
    {
      description: "Takes a while",
      inputSchema: { sku: z.string(), ms: z.number(), track: z.boolean().optional() },
    },
    async ({ sku, ms, track }: { sku: string; ms: number; track?: boolean }) => {
      started(sku);
      await sleep(ms);
      if (track) yavio.track("slow_done", { sku });
      return { content: [{ type: "text" as const, text: `slow ${sku}` }] };
    },
  );
  return server;
}

type Handle = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const handleV1: Handle = async (req, res) => {
  // Per request: wrap, connect a stateless transport, handle, tear down.
  const server = analytics.wrap(buildV1());
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
};

const handleV2: Handle = toNodeHandler(createMcpHandler(() => analytics.wrap(buildV2())));

const handle = stack === "v2" ? handleV2 : handleV1;
const http = createServer((req, res) => {
  void handle(req, res);
});

// shutdown-recipe:start
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
// shutdown-recipe:end

if (mode !== "readme") {
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
}
if (mode === "idle") {
  process.on("SIGUSR2", () => {
    void closeWithin(http, 3_000);
  });
}
if (mode === "pinned-cli") {
  withYavio(stack === "v2" ? buildV2() : buildV1(), {
    apiKey: "yav_child",
    endpoint,
    serverOnly: true,
  });
  process.on("SIGUSR2", () => {
    void (async () => {
      await closeWithin(http, 3_000);
      await analytics.shutdown();
      process.stdout.write("shutdown resolved\n");
    })();
  });
}
if (mode === "noexit") {
  // The recipe without its exit: whatever is still alive afterwards keeps
  // the process up, and the SDK must leave nothing.
  let stoppingWithoutExit: Promise<void> | undefined;
  const stopWithoutExit = (): Promise<void> => {
    stoppingWithoutExit ??= (async () => {
      await closeWithin(http, 3_000);
      await analytics.shutdown();
      process.stdout.write("shutdown resolved\n");
    })();
    return stoppingWithoutExit;
  };
  process.on("SIGTERM", stopWithoutExit);
  process.on("SIGINT", stopWithoutExit);
}

http.listen(0, "127.0.0.1", () => {
  if (mode === "none-stdin") {
    http.unref();
    process.stdin.resume();
  }
  process.stdout.write(`ready ${(http.address() as AddressInfo).port}\n`);
});
