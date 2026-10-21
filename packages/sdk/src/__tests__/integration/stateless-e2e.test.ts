/**
 * The README's "Stateless / per-request servers" pattern, end to end (#133):
 * MCP SDK v1 in stateless Streamable HTTP mode, a new McpServer per request
 * wrapped by one `createYavio()` client, 50 calls from one conversation.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { deriveSessionId } from "../../core/ids.js";
import { createYavio } from "../../server/index.js";
import { _resetGlobalState } from "../../server/proxy.js";

interface ReceivedBatch {
  events: Array<Record<string, unknown>>;
}

describe("stateless Streamable HTTP, a new McpServer per request", () => {
  const received: ReceivedBatch[] = [];
  let ingest: ReturnType<typeof createServer>;
  let endpoint: string;
  let mcp: ReturnType<typeof createServer> | undefined;

  beforeEach(async () => {
    _resetGlobalState();
    received.length = 0;
    ingest = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        received.push(JSON.parse(body) as ReceivedBatch);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: 1, rejected: 0 }));
      });
    });
    await new Promise<void>((resolve) => {
      ingest.listen(0, "127.0.0.1", () => {
        endpoint = `http://127.0.0.1:${(ingest.address() as AddressInfo).port}/v1/events`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => ingest.close(() => resolve()));
    if (mcp) await new Promise<void>((resolve) => mcp?.close(() => resolve()));
    mcp = undefined;
    _resetGlobalState();
  });

  it("50 calls from one conversation → 1 connection, 1 discovery per tool, 1 session_id, 50 tool_call", async () => {
    // Once per process.
    const yavio = createYavio({
      apiKey: "yav_e2e",
      endpoint,
      serverOnly: true,
      capture: { geo: "country" },
    });

    let built = 0;
    function buildServer() {
      built++;
      const server = new McpServer({ name: "example", version: "1.0.0" });
      server.registerTool(
        "get_price",
        { description: "Price of a SKU", inputSchema: { sku: z.string() } },
        async ({ sku }) => ({ content: [{ type: "text", text: `price of ${sku}` }] }),
      );
      server.registerTool("ping", { description: "Ping" }, async () => ({
        content: [{ type: "text", text: "pong" }],
      }));
      return server;
    }

    // Per request: wrap, connect a stateless transport, handle, tear down.
    mcp = createServer(async (req, res) => {
      const server = yavio.wrap(buildServer());
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
    await new Promise<void>((resolve) => mcp?.listen(0, "127.0.0.1", resolve));
    const url = new URL(`http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`);

    const client = new Client({ name: "e2e-client", version: "1.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(["get_price", "ping"]);

    const conversation = {
      "openai/session": "conv-e2e",
      "openai/locale": "de-DE",
      "openai/userLocation": { country: "DE", city: "Berlin" },
    };
    for (let i = 0; i < 50; i++) {
      const result = await client.callTool({
        name: "get_price",
        arguments: { sku: `SKU-${i}` },
        _meta: conversation,
      });
      expect(result.isError).toBeFalsy();
    }
    await client.close();

    // initialize + tools/list + 50 calls, each on its own instance.
    expect(built).toBeGreaterThanOrEqual(52);

    await yavio.shutdown();

    const events = received.flatMap((b) => b.events);
    const calls = events.filter((e) => e.event_type === "tool_call");
    const connections = events.filter((e) => e.event_type === "connection");
    const discoveries = events.filter((e) => e.event_type === "tool_discovery");

    expect(calls).toHaveLength(50);
    expect(calls.every((e) => e.status === "success")).toBe(true);
    expect(new Set(calls.map((e) => e.session_id))).toEqual(new Set([deriveSessionId("conv-e2e")]));
    expect(calls.every((e) => e.country_code === "DE")).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("Berlin");
    expect(connections).toHaveLength(1);
    expect(connections[0]?.session_id).toBe(deriveSessionId("conv-e2e"));
    expect(discoveries.map((e) => e.tool_name).sort()).toEqual(["get_price", "ping"]);
    // Every instance sent through the one shared transport: batches of up to
    // 100 events, not one request per instance.
    expect(received.length).toBeLessThan(10);
  });
});
