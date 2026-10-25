/**
 * The README's "Stateless / per-request servers" pattern, end to end (#133):
 * MCP SDK v1 in stateless Streamable HTTP mode, a new McpServer per request
 * wrapped by one `createYavio()` client, 50 calls from one conversation.
 */
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
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
import { perRequestSessionSuite } from "./session-key-suite.js";

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
    if (mcp) {
      mcp.closeAllConnections(); // keep-alive sockets would hold close() ~4 s
      await new Promise<void>((resolve) => mcp?.close(() => resolve()));
    }
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
    // #144: the conversation's events say where their session came from.
    // tool_discovery carries none: ingest writes it to tool_registry, which
    // keeps no session fields (review round 1).
    expect(new Set([...calls, ...connections].map((e) => e.session_source))).toEqual(
      new Set(["openai_session"]),
    );
    expect(discoveries.every((e) => e.session_source === undefined)).toBe(true);
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
    if (mcp) {
      mcp.closeAllConnections(); // keep-alive sockets would hold close() ~4 s
      await new Promise<void>((resolve) => mcp?.close(() => resolve()));
    }
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

// #173: W3C trace context on MCP SDK v1 — the HTTP header (an
// OpenTelemetry-instrumented fetch) and `_meta` (VS Code sends a traceparent
// there on the 2025 era) — stored once, as metadata.traceparent.
describe("trace context on v1 stateless Streamable HTTP (#173)", () => {
  let ingest: MockIngest;
  let mcp: ReturnType<typeof createServer> | undefined;

  beforeEach(async () => {
    _resetGlobalState();
    ingest = await startMockIngest();
  });

  afterEach(async () => {
    await ingest.close();
    if (mcp) {
      mcp.closeAllConnections();
      await new Promise<void>((resolve) => mcp?.close(() => resolve()));
    }
    mcp = undefined;
    _resetGlobalState();
  });

  it("stores the header traceparent intact, and the _meta one first, never in _requestInfo", async () => {
    // W3C's example: its parent id ends in ten decimal digits, which the PII
    // stripper's phone pattern used to cut (`…-b7ad6b[PHONE_REDACTED]-01`).
    const header = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const meta = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const yavio = createYavio({
      apiKey: "yav_e2e_trace",
      endpoint: ingest.endpoint,
      serverOnly: true,
    });
    mcp = createServer(async (req, res) => {
      const server = yavio.wrap(new McpServer({ name: "example", version: "1.0.0" }));
      server.registerTool("get_price", { inputSchema: { sku: z.string() } }, async ({ sku }) => ({
        content: [{ type: "text", text: `price of ${sku}` }],
      }));
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
    await client.connect(
      new StreamableHTTPClientTransport(url, { requestInit: { headers: { traceparent: header } } }),
    );
    await client.callTool({ name: "get_price", arguments: { sku: "A1" } });
    await client.callTool({
      name: "get_price",
      arguments: { sku: "A2" },
      _meta: { "vscode.conversationId": "conv-173", traceparent: meta, baggage: "user.id=u-1" },
    });
    await client.close();
    await yavio.shutdown();

    const calls = ingest.events.filter((e) => e.event_type === "tool_call");
    expect(calls.map((e) => e.metadata)).toEqual([{ traceparent: header }, { traceparent: meta }]);
    for (const call of calls) {
      const inputValues = call.input_values as { _requestInfo?: { headers?: object } };
      expect(inputValues._requestInfo?.headers).not.toHaveProperty("traceparent");
    }
    expect((calls[1]?.input_values as Record<string, unknown>)._meta).toEqual({
      "vscode.conversationId": "conv-173",
    });
    expect(JSON.stringify(calls)).not.toContain("user.id");
  });
});

// #144: sessionKey, the built-in client keys, per_request and its connection
// collapse — the cases shared with the v2 file, on v1 stateless HTTP.
perRequestSessionSuite({
  name: "MCP SDK v1 stateless Streamable HTTP",
  newServer: () => new McpServer({ name: "example", version: "1.0.0" }),
  handler: (build, auth) => async (req: IncomingMessage, res: ServerResponse) => {
    // What an auth middleware does: v1 passes req.auth on as extra.authInfo.
    if (auth) Object.assign(req, { auth });
    const server = build() as unknown as McpServer;
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
  },
  connect: async (url, info, headers) => {
    const client = new Client(info);
    await client.connect(
      new StreamableHTTPClientTransport(url, headers ? { requestInit: { headers } } : undefined),
    );
    return client;
  },
});
