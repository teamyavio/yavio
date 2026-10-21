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
import { type MockIngest, callTool, callViaClient, startMockIngest, v1Extra } from "./helpers.js";

describe("stateless Streamable HTTP, a new McpServer per request", () => {
  let ingest: MockIngest;
  let endpoint: string;
  let mcp: ReturnType<typeof createServer> | undefined;

  beforeEach(async () => {
    _resetGlobalState();
    ingest = await startMockIngest();
    endpoint = ingest.endpoint;
  });

  afterEach(async () => {
    await ingest.close();
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

    const events = ingest.events;
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
    expect(ingest.batches.length).toBeLessThan(10);
  });
});

/**
 * Client identity without `initialize` (#142): on a stateless host the
 * instance serving tools/call never saw the handshake, so the connection
 * event takes the client from the request's User-Agent — and says so.
 */
describe("client identity on the connection event (#142)", () => {
  let ingest: MockIngest;
  let mcp: ReturnType<typeof createServer> | undefined;

  beforeEach(async () => {
    _resetGlobalState();
    ingest = await startMockIngest();
  });

  afterEach(async () => {
    await ingest.close();
    if (mcp) await new Promise<void>((resolve) => mcp?.close(() => resolve()));
    mcp = undefined;
    _resetGlobalState();
  });

  function statelessHost(yavio: ReturnType<typeof createYavio>) {
    mcp = createServer(async (req, res) => {
      const server = new McpServer({ name: "example", version: "1.0.0" });
      server.registerTool("ping", { description: "Ping" }, async () => ({
        content: [{ type: "text", text: "pong" }],
      }));
      const wrapped = yavio.wrap(server);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await wrapped.connect(transport);
      await transport.handleRequest(req, res);
    });
    return new Promise<URL>((resolve) =>
      mcp?.listen(0, "127.0.0.1", () =>
        resolve(new URL(`http://127.0.0.1:${(mcp?.address() as AddressInfo).port}/mcp`)),
      ),
    );
  }

  async function callOnce(url: URL, userAgent: string) {
    const client = new Client({ name: "handshake-client", version: "3.0" });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { "user-agent": userAgent } },
      }),
    );
    await client.callTool({ name: "ping", _meta: { "openai/session": "conv-ua" } });
    await client.close();
    return client;
  }

  it("a stateless v1 host: the client from the User-Agent, the protocol version from its header, the source recorded", async () => {
    const yavio = createYavio({ apiKey: "yav_ua", endpoint: ingest.endpoint, serverOnly: true });
    const url = await statelessHost(yavio);
    await callOnce(url, "openai-mcp/1.0.0");
    await yavio.shutdown();

    const [connection] = ingest.ofType("connection");
    expect(connection?.client_name).toBe("openai-mcp");
    expect(connection?.client_version).toBe("1.0.0");
    expect(connection?.platform).toBe("chatgpt");
    // The handshake's clientInfo never reached the instance that served the call.
    expect(connection?.client_name).not.toBe("handshake-client");
    expect(connection?.protocol_version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(connection?.metadata).toEqual({
      intent_enabled: false,
      client_info_source: "user_agent",
    });
  });

  it("a generic User-Agent names no client: the connection stays without one", async () => {
    const yavio = createYavio({
      apiKey: "yav_ua_generic",
      endpoint: ingest.endpoint,
      serverOnly: true,
    });
    const url = await statelessHost(yavio);
    await callOnce(url, "node");
    await yavio.shutdown();

    const [connection] = ingest.ofType("connection");
    expect(connection?.client_name).toBeUndefined();
    expect(connection?.client_version).toBeUndefined();
    expect(connection?.metadata).toEqual({ intent_enabled: false });
  });

  it("a long-lived v1 server: the initialize handshake wins over the User-Agent", async () => {
    const yavio = createYavio({
      apiKey: "yav_ua_init",
      endpoint: ingest.endpoint,
      serverOnly: true,
    });
    const raw = new McpServer({ name: "long-lived", version: "1.0.0" });
    raw.registerTool("ping", { description: "Ping" }, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    const wrapped = yavio.wrap(raw);
    // One handshake on the long-lived server, then a call whose request
    // carries a User-Agent of its own.
    await callViaClient(wrapped, { name: "ping", _meta: { "openai/session": "conv-init-1" } });
    await callTool(
      raw,
      "ping",
      undefined,
      v1Extra({
        sessionId: undefined,
        _meta: { "openai/session": "conv-init-2" },
        requestInfo: { headers: { "user-agent": "openai-mcp/1.0.0" } },
      }),
    );
    await yavio.shutdown();

    const connections = ingest.ofType("connection");
    expect(connections).toHaveLength(2);
    for (const connection of connections) {
      expect(connection.client_name).toBe("c");
      expect(connection.metadata).toEqual({
        intent_enabled: false,
        client_info_source: "initialize",
      });
    }
  });
});
