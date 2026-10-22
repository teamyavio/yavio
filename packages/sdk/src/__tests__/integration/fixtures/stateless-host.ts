/**
 * The child of `signals-process.test.ts` (#142): the README's stateless host
 * — MCP SDK v1 Streamable HTTP, a new McpServer per request wrapped by one
 * `createYavio()` client — run as its own process, so a real SIGTERM, the
 * app's own handler and `process.exit()` are what the test exercises.
 * Started with `node --import tsx` against the SDK's source.
 *
 * Env: ENDPOINT (the mock ingest), MODE = "readme" (the README's handler:
 * close the HTTP server, await shutdown(), exit 0) | "none" (no handler of
 * its own: the SDK drains and hands the signal back, Node's default exit).
 * Prints `ready <port>` once listening and `started <sku>` when the `slow`
 * tool begins, so the test can send the signal with that call in flight.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createYavio } from "../../../server/index.js";

const endpoint = process.env.ENDPOINT;
if (!endpoint) throw new Error("ENDPOINT is not set");
const mode = process.env.MODE ?? "readme";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Once per process.
const analytics = createYavio({ apiKey: "yav_child", endpoint, serverOnly: true });

function buildServer(): McpServer {
  const server = new McpServer({ name: "child", version: "1.0.0" });
  server.registerTool(
    "get_price",
    { description: "Price of a SKU", inputSchema: { sku: z.string() } },
    async ({ sku }) => ({ content: [{ type: "text", text: `price of ${sku}` }] }),
  );
  server.registerTool(
    "slow",
    { description: "Takes a while", inputSchema: { sku: z.string(), ms: z.number() } },
    async ({ sku, ms }) => {
      process.stdout.write(`started ${sku}\n`); // the test waits for this before it sends the signal
      await sleep(ms);
      return { content: [{ type: "text", text: `slow ${sku}` }] };
    },
  );
  return server;
}

const http = createServer(async (req, res) => {
  // Per request: wrap, connect a stateless transport, handle, tear down.
  const server = analytics.wrap(buildServer());
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
});

if (mode === "readme") {
  process.on("SIGTERM", async () => {
    // The callback waits for the requests in flight (keep-alive sockets too).
    await new Promise((resolve) => http.close(resolve));
    await analytics.shutdown();
    process.exit(0);
  });
}

http.listen(0, "127.0.0.1", () => {
  process.stdout.write(`ready ${(http.address() as AddressInfo).port}\n`);
});
