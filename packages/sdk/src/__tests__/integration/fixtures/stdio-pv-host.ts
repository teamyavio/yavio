/**
 * The child of `protocol-version.test.ts` (#170): a stdio MCP server on the
 * stack under test, wrapped by one `createYavio()` client, that delivers its
 * events when the client closes stdin (await `shutdown()`, then exit) — the
 * shape of #167's `stdio-host.ts` in MODE=stdin-end. Started with
 * `node --import tsx` against the SDK's source.
 *
 * Env: ENDPOINT (the mock ingest); STACK = "v1" (`StdioServerTransport`) |
 * "v2" (`serveStdio`, which pins the era the client opens with). stdout is
 * the MCP wire. The SDK writes its own lines to stderr (#174), so the fixture
 * needs no console redirect.
 */
import { McpServer as McpServerV1 } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer as McpServerV2 } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { createYavio } from "../../../server/index.js";

const endpoint = process.env.ENDPOINT;
if (!endpoint) throw new Error("ENDPOINT is not set");
const analytics = createYavio({ apiKey: "yav_stdio_pv", endpoint, serverOnly: true });
const echo = async ({ q }: { q: string }) => ({ content: [{ type: "text" as const, text: q }] });

if (process.env.STACK === "v2") {
  serveStdio(() => {
    const server = new McpServerV2({ name: "child", version: "1.0.0" });
    server.registerTool("echo", { description: "Echo", inputSchema: { q: z.string() } }, echo);
    return analytics.wrap(server);
  });
} else {
  const server = analytics.wrap(new McpServerV1({ name: "child", version: "1.0.0" }));
  server.registerTool("echo", { description: "Echo", inputSchema: { q: z.string() } }, echo);
  await server.connect(new StdioServerTransport());
}

process.stdin.on("end", async () => {
  await analytics.shutdown();
  process.exit(0);
});
