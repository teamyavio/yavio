/**
 * MCP SDK v2 (`@modelcontextprotocol/server` / `client` / `node`), #133.
 *
 * v2 has no `tool()`, registers its low-level handlers by method string,
 * keeps the request `_meta` under `ctx.mcpReq`, throws for an unknown tool
 * where v1 returns an isError result, and negotiates the 2026-07-28 era only
 * over Streamable HTTP. Every one of those shows up here against the real
 * packages, not a fake.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { InMemoryTransport, McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import type {
  BaseEvent,
  ConnectionEvent,
  ToolCallEvent,
  ToolDiscoveryEvent,
} from "@yavio/shared/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { deriveSessionId } from "../../core/ids.js";
import type { YavioConfig } from "../../core/types.js";
import { createYavioContext } from "../../server/context.js";
import { createYavio, withYavio } from "../../server/index.js";
import { _resetGlobalState, createProxy } from "../../server/proxy.js";
import { _sharedStateCount } from "../../server/shared.js";
import type { Transport } from "../../transport/types.js";
import { type MockIngest, registeredTool, startMockIngest } from "./helpers.js";

function createMockTransport(): Transport & { sent: BaseEvent[][] } {
  const sent: BaseEvent[][] = [];
  return {
    sent,
    send: (events) => {
      sent.push(events);
    },
    flush: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

const makeConfig = (overrides: Partial<YavioConfig> = {}): YavioConfig => ({
  apiKey: "yav_test",
  endpoint: "http://localhost:3001/v1/events",
  capture: {
    inputValues: true,
    outputValues: true,
    geo: "country",
    tokens: true,
    retries: true,
    rejectedInputValues: false,
  },
  serverOnly: true,
  intent: { enabled: false, required: true, description: "test" },
  tools: {},
  shutdownTimeoutMs: 10_000,
  shutdownTimeoutMsSource: "default",
  ...overrides,
});

const CLIENT_META = {
  "openai/session": "conv-v2-1",
  "openai/locale": "de-DE",
  "openai/subject": "v1/subject-1",
  "openai/userLocation": { country: "DE", city: "Duisburg" },
};

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

const toolCalls = (events: BaseEvent[][]): ToolCallEvent[] =>
  events.flat().filter((e): e is ToolCallEvent => e.event_type === "tool_call");
const discoveries = (events: BaseEvent[][]): ToolDiscoveryEvent[] =>
  events.flat().filter((e): e is ToolDiscoveryEvent => e.event_type === "tool_discovery");
const connections = (events: BaseEvent[][]): ConnectionEvent[] =>
  events.flat().filter((e): e is ConnectionEvent => e.event_type === "connection");

interface Harness {
  client: Client;
  events: BaseEvent[][];
  proxy: McpServer;
  server: McpServer;
}

async function setup(
  register: (proxy: McpServer, server: McpServer) => void,
  overrides: Partial<YavioConfig> = {},
): Promise<Harness> {
  const server = new McpServer({ name: "v2-test", version: "1.0" });
  const transport = createMockTransport();
  const proxy = createProxy(server, makeConfig(overrides), transport, "0.5.0");
  register(proxy, server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await proxy.connect(serverTransport);
  const client = new Client({ name: "v2-test-client", version: "1.0" });
  await client.connect(clientTransport);
  return { client, events: transport.sent, proxy, server };
}

describe("MCP SDK v2 — legacy era over InMemoryTransport", () => {
  beforeEach(() => _resetGlobalState());

  it("wraps a v2 McpServer (no tool()) without throwing, with an API key set", () => {
    const server = new McpServer({ name: "v2", version: "1.0" });
    const wrapped = withYavio(server, { apiKey: "yav_test", serverOnly: true });
    expect(wrapped).not.toBe(server);
    expect(typeof wrapped.registerTool).toBe("function");
    // v2 has no tool(); the proxy must not invent one.
    expect((wrapped as { tool?: unknown }).tool).toBeUndefined();
    expect(() =>
      wrapped.registerTool("x", { inputSchema: { q: z.string() } }, async () => ok("x")),
    ).not.toThrow();
  });

  it("captures a tool call with _meta from ctx.mcpReq, client meta, and the openai/session-derived session id", async () => {
    let seenExtra: unknown;
    const h = await setup((proxy) => {
      proxy.registerTool(
        "get_price",
        { description: "d", inputSchema: { sku: z.string() } },
        async ({ sku }, extra) => {
          seenExtra = extra;
          return ok(`price of ${sku}`);
        },
      );
    });

    const result = await h.client.callTool({
      name: "get_price",
      arguments: { sku: "A1" },
      _meta: CLIENT_META,
    });
    expect(result.isError).toBeFalsy();
    // The shape the SDK had to learn: _meta lives under mcpReq on v2.
    expect((seenExtra as { _meta?: unknown })._meta).toBeUndefined();
    expect((seenExtra as { mcpReq: { _meta: unknown } }).mcpReq._meta).toEqual(CLIENT_META);

    const [event] = toolCalls(h.events);
    expect(event?.event_name).toBe("get_price");
    expect(event?.status).toBe("success");
    expect(event?.session_id).toBe(deriveSessionId("conv-v2-1"));
    expect(event?.locale).toBe("de-DE");
    expect(event?.subject_id).toBe("v1/subject-1");
    expect(event?.country_code).toBe("DE");
    const values = event?.input_values as Record<string, unknown>;
    expect(values.sku).toBe("A1");
    expect(values._meta).toEqual({
      "openai/session": "conv-v2-1",
      "openai/locale": "de-DE",
      "openai/subject": "v1/subject-1",
      "openai/userLocation": { country: "DE" },
    });
    expect(JSON.stringify(event)).not.toContain("Duisburg");

    const [connection] = connections(h.events);
    expect(connection?.client_name).toBe("v2-test-client");
    expect(connection?.session_id).toBe(deriveSessionId("conv-v2-1"));
  });

  it("emits tool_discovery once per tool from tools/list with the listed JSON Schema", async () => {
    const h = await setup((proxy) => {
      proxy.registerTool(
        "get_price",
        { description: "Price lookup", inputSchema: { sku: z.string() } },
        async () => ok("x"),
      );
      proxy.registerTool("ping", { description: "Ping" }, async () => ok("pong"));
    });

    await h.client.listTools();
    await h.client.listTools();

    const events = discoveries(h.events);
    expect(events.map((e) => e.tool_name).sort()).toEqual(["get_price", "ping"]);
    const price = events.find((e) => e.tool_name === "get_price");
    expect(price?.description).toBe("Price lookup");
    expect(
      (price?.input_schema as { properties: Record<string, unknown> }).properties,
    ).toHaveProperty("sku");
  });

  it("counts a schema-rejected call as one validation event (client sees isError)", async () => {
    let handlerRan = false;
    const h = await setup((proxy) => {
      proxy.registerTool("get_price", { inputSchema: { sku: z.string() } }, async () => {
        handlerRan = true;
        return ok("x");
      });
    });

    const result = await h.client.callTool({
      name: "get_price",
      arguments: { sku: 42 },
      _meta: CLIENT_META,
    });

    expect(result.isError).toBe(true);
    expect(handlerRan).toBe(false);
    const events = toolCalls(h.events);
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("error");
    expect(events[0]?.error_category).toBe("validation");
    expect(events[0]?.error_message).toContain("Input validation error");
    expect(events[0]?.latency_ms).toBeUndefined();
    expect(events[0]?.input_keys).toEqual({ sku: true });
    // rejectedInputValues is off: the rejected value is not stored.
    expect(JSON.stringify(events[0]?.input_values)).not.toContain("42");
    expect(events[0]?.locale).toBe("de-DE");
  });

  it("counts an unknown tool as one validation event and still throws to the client", async () => {
    const h = await setup((proxy) => {
      proxy.registerTool("get_price", { inputSchema: { sku: z.string() } }, async () => ok("x"));
    });

    await expect(
      h.client.callTool({ name: "nope", arguments: {}, _meta: CLIENT_META }),
    ).rejects.toThrow(/Tool nope not found/);

    const events = toolCalls(h.events);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_name).toBe("nope");
    expect(events[0]?.error_category).toBe("validation");
    expect(events[0]?.error_message).toContain("Tool nope not found");
    expect(events[0]?.latency_ms).toBeUndefined();
  });

  it("counts a disabled tool as one validation event", async () => {
    let registered: { disable(): void } | undefined;
    const h = await setup((proxy) => {
      registered = proxy.registerTool("get_price", { inputSchema: { sku: z.string() } }, async () =>
        ok("x"),
      ) as { disable(): void };
    });
    registered?.disable();

    await expect(
      h.client.callTool({ name: "get_price", arguments: { sku: "A1" } }),
    ).rejects.toThrow(/disabled/);

    const events = toolCalls(h.events);
    expect(events).toHaveLength(1);
    expect(events[0]?.error_category).toBe("validation");
  });

  it("records a thrown handler error as one unknown-category event", async () => {
    const h = await setup((proxy) => {
      proxy.registerTool("boom", { inputSchema: { sku: z.string() } }, async () => {
        throw new Error("exploded");
      });
    });

    const result = await h.client.callTool({ name: "boom", arguments: { sku: "A1" } });
    expect(result.isError).toBe(true);

    const events = toolCalls(h.events);
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("error");
    expect(events[0]?.error_category).toBe("unknown");
    expect(events[0]?.error_message).toBe("exploded");
    expect(typeof events[0]?.latency_ms).toBe("number");
  });

  it("advertises and strips `context` with intent capture on", async () => {
    let seenArgs: unknown;
    const h = await setup(
      (proxy) => {
        proxy.registerTool("search", { inputSchema: { q: z.string() } }, async (args) => {
          seenArgs = args;
          return ok("x");
        });
      },
      { intent: { enabled: true, required: true, description: "why?" } },
    );

    const listed = await h.client.listTools();
    const schema = listed.tools[0]?.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toHaveProperty("context");
    expect(schema.required).toContain("context");

    await h.client.callTool({
      name: "search",
      arguments: { q: "x", context: "find the price" },
    });
    expect(seenArgs).toEqual({ q: "x" });
    const [event] = toolCalls(h.events);
    expect(event?.intent_signals).toEqual({
      intent: "find the price",
      source: "context_parameter",
    });
    expect(event?.intent_context).toBe("required");
  });

  it("honours a per-tool inputValues: false override", async () => {
    const h = await setup(
      (proxy) => {
        proxy.registerTool("secret", { inputSchema: { iban: z.string() } }, async () => ok("x"));
        proxy.registerTool("open", { inputSchema: { q: z.string() } }, async () => ok("x"));
      },
      { tools: { secret: { inputValues: false } } },
    );

    await h.client.callTool({ name: "secret", arguments: { iban: "DE00" }, _meta: CLIENT_META });
    await h.client.callTool({ name: "open", arguments: { q: "x" }, _meta: CLIENT_META });

    const events = toolCalls(h.events);
    const secret = events.find((e) => e.event_name === "secret");
    const open = events.find((e) => e.event_name === "open");
    expect(secret?.input_values).toBeUndefined();
    expect(secret?.locale).toBeUndefined();
    expect(open?.input_values).toMatchObject({ q: "x" });
    expect(open?.locale).toBe("de-DE");
  });

  it("keeps the fluent registerTool(config, cb) form chained on the proxy", async () => {
    // A framework facade over the v2 server: registerTool(config, cb) returning `this`.
    class Fluent extends McpServer {
      // biome-ignore lint/suspicious/noExplicitAny: facade signature under test
      override registerTool(...args: any[]): any {
        if (typeof args[0] === "object" && args[0] !== null) {
          const { name, ...config } = args[0] as { name: string };
          super.registerTool(name, config, args[1]);
          return this;
        }
        return super.registerTool(args[0], args[1], args[2]);
      }
    }
    const server = new Fluent({ name: "fluent", version: "1.0" });
    const transport = createMockTransport();
    interface FluentProxy {
      registerTool(config: unknown, cb: unknown): FluentProxy;
      connect: McpServer["connect"];
    }
    const proxy = createProxy(server, makeConfig(), transport, "0.5.0") as unknown as FluentProxy;
    const chained = proxy
      .registerTool({ name: "a", inputSchema: { q: z.string() } }, async () => ok("a"))
      .registerTool({ name: "b", inputSchema: { q: z.string() } }, async () => ok("b"));
    expect(chained).toBe(proxy);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await proxy.connect(serverTransport);
    const client = new Client({ name: "c", version: "1.0" });
    await client.connect(clientTransport);
    await client.callTool({ name: "a", arguments: { q: "x" } });
    await client.callTool({ name: "b", arguments: { q: "x" } });
    expect(toolCalls(transport.sent).map((e) => e.event_name)).toEqual(["a", "b"]);
  });

  it("tracking calls from inside a v2 handler carry the call's session", async () => {
    const ctx = createYavioContext();
    const h = await setup((proxy) => {
      proxy.registerTool("buy", { inputSchema: { sku: z.string() } }, async () => {
        ctx.identify("user-9");
        ctx.conversion("purchase", { value: 10, currency: "EUR" });
        return ok("x");
      });
    });

    await h.client.callTool({ name: "buy", arguments: { sku: "A1" }, _meta: CLIENT_META });

    const all = h.events.flat();
    const conversion = all.find((e) => e.event_type === "conversion");
    const call = toolCalls(h.events)[0];
    expect(conversion?.session_id).toBe(deriveSessionId("conv-v2-1"));
    expect(conversion?.trace_id).toBe(call?.trace_id);
    expect(call?.user_id).toBe("user-9");
  });
});

describe("MCP SDK v2 — 2026-07-28 era over Streamable HTTP, a new server per request", () => {
  let ingest: MockIngest;
  let ingestUrl: string;
  let mcp: ReturnType<typeof createServer> | undefined;

  beforeEach(async () => {
    _resetGlobalState();
    ingest = await startMockIngest();
    ingestUrl = ingest.endpoint;
  });

  afterEach(async () => {
    await ingest.close();
    if (mcp) await new Promise<void>((resolve) => mcp?.close(() => resolve()));
    mcp = undefined;
  });

  it("negotiates 2026-07-28, shares one session across per-request instances, and reads the client from the envelope", async () => {
    const yavio = createYavio({ apiKey: "yav_v2_http", endpoint: ingestUrl, serverOnly: true });
    let built = 0;
    const buildServer = () => {
      built++;
      const server = new McpServer({ name: "stateless-v2", version: "1.0" });
      server.registerTool(
        "get_price",
        { description: "d", inputSchema: { sku: z.string() } },
        async ({ sku }) => ok(`price of ${sku}`),
      );
      return server;
    };
    // The v2 serving entry: the factory runs once per HTTP request.
    const handler = createMcpHandler(() => yavio.wrap(buildServer()));
    const nodeHandler = toNodeHandler(handler);
    const httpServer = createServer((req, res) => {
      void nodeHandler(req, res);
    });
    mcp = httpServer;
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const url = new URL(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`);

    const client = new Client(
      { name: "modern-client", version: "7.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(new StreamableHTTPClientTransport(url));
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");

    await client.listTools();
    for (let i = 0; i < 5; i++) {
      const result = await client.callTool({
        name: "get_price",
        arguments: { sku: `A${i}` },
        _meta: { "openai/session": "conv-http-1", "openai/locale": "fr-FR" },
      });
      expect(result.isError).toBeFalsy();
    }
    await client.close();
    // A fresh instance per request, as the factory contract says.
    expect(built).toBeGreaterThanOrEqual(6);
    expect(_sharedStateCount()).toBe(1);

    await yavio.shutdown();
    const events = ingest.events;
    const calls = events.filter((e) => e.event_type === "tool_call");
    const conns = events.filter((e) => e.event_type === "connection");
    const discs = events.filter((e) => e.event_type === "tool_discovery");
    expect(calls).toHaveLength(5);
    expect(new Set(calls.map((e) => e.session_id))).toEqual(
      new Set([deriveSessionId("conv-http-1")]),
    );
    expect(calls.every((e) => e.locale === "fr-FR")).toBe(true);
    expect(conns).toHaveLength(1);
    expect(conns[0]?.client_name).toBe("modern-client");
    expect(conns[0]?.client_version).toBe("7.0");
    expect(discs).toHaveLength(1);
    // The HTTP request reached the event: allowlisted headers only.
    const requestInfo = (calls[0]?.input_values as { _requestInfo?: Record<string, unknown> })
      ._requestInfo;
    expect(requestInfo?.headers).toHaveProperty("user-agent");
    expect(requestInfo?.headers).not.toHaveProperty("authorization");
    expect(requestInfo?.headers).not.toHaveProperty("mcp-session-id");
    // What v1 records: headers only. The web Request's URL is never read.
    expect(requestInfo).not.toHaveProperty("url");
    expect(JSON.stringify(calls)).not.toContain("127.0.0.1");
  });

  it("the 2026-07-28 envelope names the client even when the User-Agent names another (#142)", async () => {
    const yavio = createYavio({ apiKey: "yav_v2_env", endpoint: ingestUrl, serverOnly: true });
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "stateless-v2", version: "1.0" });
      server.registerTool("ping", { description: "d" }, async () => ok("pong"));
      return yavio.wrap(server);
    });
    const nodeHandler = toNodeHandler(handler);
    const httpServer = createServer((req, res) => {
      void nodeHandler(req, res);
    });
    mcp = httpServer;
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const url = new URL(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`);

    const client = new Client(
      { name: "envelope-client", version: "7.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { "user-agent": "other-agent/9.9" } },
      }),
    );
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    await client.callTool({ name: "ping", _meta: { "openai/session": "conv-env-ua" } });
    await client.close();
    await yavio.shutdown();

    const [connection] = ingest.events.filter((e) => e.event_type === "connection");
    expect(connection?.client_name).toBe("envelope-client");
    expect(connection?.client_version).toBe("7.0");
    expect(connection?.protocol_version).toBe("2026-07-28");
    expect(connection?.metadata).toEqual({ intent_enabled: false, client_info_source: "envelope" });
  });

  it("records v2's wire rejection of a malformed result as a server error, not a success", async () => {
    // A tool registered before the wrap: the protocol layer wraps the handler
    // v2 already stored, so the wire validation of the result throws through
    // the status wrapper after the callback recorded a success.
    const server = new McpServer({ name: "malformed", version: "1.0" });
    server.registerTool(
      "get_price",
      { inputSchema: { sku: z.string() } },
      async () => ({ content: "not an array" }) as unknown as { content: [] },
    );
    const transport = createMockTransport();
    const proxy = createProxy(server, makeConfig(), transport, "0.5.0", undefined, {
      instrumentExisting: true,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await proxy.connect(serverTransport);
    const client = new Client({ name: "c", version: "1.0" });
    await client.connect(clientTransport);

    await expect(client.callTool({ name: "get_price", arguments: { sku: "A1" } })).rejects.toThrow(
      /Invalid tools\/call result/,
    );

    const events = toolCalls(transport.sent);
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("error");
    expect(events[0]?.error_category).toBe("server");
    expect(events[0]?.error_message).toContain("Invalid tools/call result");
    expect(typeof events[0]?.latency_ms).toBe("number");
  });

  it("records v2's wire rejection as a server error on the lazy path too (tool registered after the wrap)", async () => {
    const h = await setup((proxy) => {
      proxy.registerTool(
        "get_price",
        { inputSchema: { sku: z.string() } },
        async () => ({ content: "not an array" }) as unknown as { content: [] },
      );
    });
    await expect(
      h.client.callTool({ name: "get_price", arguments: { sku: "A1" } }),
    ).rejects.toThrow(/Invalid tools\/call result/);
    const events = toolCalls(h.events);
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("error");
    expect(events[0]?.error_category).toBe("server");
    expect(events[0]?.error_message).toContain("Invalid tools/call result");
  });

  it("reads the client identity from the per-request envelope when no handshake is known", async () => {
    // A per-request instance never saw the initialize handshake, so
    // getClientVersion() is empty; the envelope is the only source. Fails
    // without the envelope read in extra.ts.
    const server = new McpServer({ name: "envelope", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, makeConfig({ serverOnly: true }), transport, "0.5.0");
    proxy.registerTool("get_price", { inputSchema: { sku: z.string() } }, async () => ok("x"));
    const handler = registeredTool(server, "get_price")?.handler;
    if (!handler) throw new Error("get_price is not registered");
    await handler(
      { sku: "A1" },
      {
        mcpReq: {
          id: 1,
          method: "tools/call",
          _meta: { "openai/session": "conv-envelope" },
          envelope: {
            "io.modelcontextprotocol/clientInfo": { name: "envelope-client", version: "9.1" },
          },
        },
      },
    );
    const [connection] = connections(transport.sent);
    expect(connection?.client_name).toBe("envelope-client");
    expect(connection?.client_version).toBe("9.1");
    expect(connection?.session_id).toBe(deriveSessionId("conv-envelope"));
  });
});
