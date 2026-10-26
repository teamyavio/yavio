/**
 * MCP SDK v2 (`@modelcontextprotocol/server` / `client` / `node`), #133.
 *
 * v2 has no `tool()`, registers its low-level handlers by method string,
 * keeps the request `_meta` under `ctx.mcpReq`, throws for an unknown tool
 * where v1 returns an isError result, and negotiates the 2026-07-28 era
 * through `createMcpHandler` (Streamable HTTP) and `serveStdio` when the
 * client asks for it, while a bare `connect()` (InMemoryTransport) stays on
 * 2025-11-25 (#172). Every one of those shows up here against the real
 * packages, not a fake; `serveStdio` over a real stdio child in
 * protocol-version.test.ts (#170, #172), push-style requests by era at the end.
 */
import { randomUUID } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { NodeStreamableHTTPServerTransport, toNodeHandler } from "@modelcontextprotocol/node";
import {
  BAGGAGE_META_KEY,
  InMemoryTransport,
  McpServer,
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
  UrlElicitationRequiredError,
  acceptedContent,
  createMcpHandler,
  inputRequired,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
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
import { type PerRequestStack, perRequestSessionSuite } from "./session-key-suite.js";

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

/**
 * The JSON a leak check reads: the event without `event_id`, `trace_id`,
 * `session_id` and `timestamp`, each checked for its shape first. The SDK
 * makes those up, and a random id holds any short string now and then
 * (`leakScan()` in proxy.test.ts). Everything left is fixed by the test's
 * inputs.
 */
function leakScan(event: Record<string, unknown> | undefined): string {
  const { event_id, trace_id, session_id, timestamp, ...fixed } = event ?? {};
  expect(event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(trace_id).toMatch(/^tr_[\w-]{21}$/);
  expect(session_id).toMatch(/^ses_[\w-]{21}$/);
  expect(timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  return JSON.stringify(fixed);
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

// #144: the cases shared with the v1 file, on v2's per-request entry
// (createMcpHandler + toNodeHandler) — the 2025 era through its stateless
// legacy fallback, and the 2026-07-28 era, which has no Mcp-Session-Id at all.
function v2Stack(name: string, negotiate: boolean): PerRequestStack {
  return {
    name,
    newServer: () => new McpServer({ name: "stateless-v2", version: "1.0" }),
    handler: (build, auth) => {
      const nodeHandler = toNodeHandler(createMcpHandler(() => build() as unknown as McpServer));
      return (req: IncomingMessage, res: ServerResponse) => {
        // What an auth middleware does; toNodeHandler forwards req.auth.
        if (auth) Object.assign(req, { auth });
        void nodeHandler(req, res);
      };
    },
    connect: async (url, info, headers) => {
      const client = new Client(
        info,
        negotiate ? { versionNegotiation: { mode: "auto" } } : undefined,
      );
      await client.connect(
        new StreamableHTTPClientTransport(url, headers ? { requestInit: { headers } } : undefined),
      );
      expect(client.getNegotiatedProtocolVersion() === "2026-07-28").toBe(negotiate);
      return client;
    },
  };
}
perRequestSessionSuite(v2Stack("MCP SDK v2 createMcpHandler, 2025 era", false));
perRequestSessionSuite(v2Stack("MCP SDK v2 createMcpHandler, 2026-07-28 era", true));

describe("MCP SDK v2 — a long-lived server on a session-generating transport (#144)", () => {
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

  it("pins ctx.sessionId: an era-negotiating client lands on the 2025 era there, and Mcp-Session-Id is the session — sessionKey is not called", async () => {
    const sessionKey = vi.fn(() => "never-used");
    const yavio = createYavio({
      apiKey: "yav_v2_sessionful",
      endpoint: ingest.endpoint,
      serverOnly: true,
      sessionKey,
    });
    const seen = new Set<unknown>();
    const server = new McpServer({ name: "sessionful-v2", version: "1.0" });
    server.registerTool(
      "get_price",
      { description: "d", inputSchema: { sku: z.string() } },
      async ({ sku }, ctx) => {
        seen.add((ctx as { sessionId?: unknown }).sessionId);
        return ok(`price of ${sku}`);
      },
    );
    const wrapped = yavio.wrap(server);
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    await wrapped.connect(transport);
    const httpServer = createServer((req, res) => {
      void transport.handleRequest(req, res);
    });
    mcp = httpServer;
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const url = new URL(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`);

    const client = new Client(
      { name: "modern-client", version: "7.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(new StreamableHTTPClientTransport(url));
    // A sessionful transport serves the 2025 handshake: the client falls back.
    expect(client.getNegotiatedProtocolVersion()).toMatch(/^2025-/);
    for (let i = 0; i < 5; i++) {
      await client.callTool({ name: "get_price", arguments: { sku: `A${i}` } });
    }
    await client.close();
    await yavio.shutdown();

    expect(seen.size).toBe(1);
    const [mcpSessionId] = [...seen];
    expect(typeof mcpSessionId).toBe("string");
    const calls = ingest.events.filter((e) => e.event_type === "tool_call");
    expect(calls).toHaveLength(5);
    expect(new Set(calls.map((e) => e.session_id))).toEqual(
      new Set([deriveSessionId(mcpSessionId as string)]),
    );
    expect(new Set(calls.map((e) => e.session_source))).toEqual(new Set(["mcp_session_id"]));
    expect(sessionKey).not.toHaveBeenCalled();
  });
});

// #168: a tool that asks for input. On 2026-07-28 every round is its own
// tools/call request (multi-round-trip requests); on the 2025 era v2's legacy
// shim (on by default) fulfils the input request over a server-to-client
// request and re-enters the handler inside the same tools/call. Either way it
// is one call: one tool_call event, from the round whose result is final.
describe("MCP SDK v2 — a tool call that asks for input is one tool_call (#168)", () => {
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

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const THINK_MS = 200;
  const confirmSchema = z.object({ confirm: z.boolean() });
  const regionSchema = z.object({ region: z.string() });

  interface DeployOptions {
    twoRounds?: boolean;
    stateOnly?: boolean;
    badOutput?: boolean;
    throwFinal?: boolean;
    urlAfterConfirm?: boolean;
    /** Once round 1 ran, the instances serving the retry have the tool changed, removed or disabled (a fleet mid-deploy). */
    afterRound1?: "schema_changed" | "removed" | "disabled";
    /** Round 1 disables the tool as it asks: the shim's re-entry finds it disabled. */
    disableWhileAsking?: boolean;
    /** The server's `requestState.verify` hook refuses every state (a signed state past its expiry). */
    rejectState?: boolean;
    /** Round 1's input_required result also carries `isError: true`. */
    interimIsError?: boolean;
  }

  const mrtrServer = (opts: DeployOptions) =>
    new McpServer(
      { name: "mrtr", version: "1.0" },
      opts.rejectState
        ? {
            requestState: {
              verify: (state: string) => {
                throw new Error(`expired: ${state}`);
              },
            },
          }
        : undefined,
    );

  /**
   * As in v2's own `inputRequired` docs: round 1 works 40 ms and asks for a
   * confirmation; with `twoRounds` a confirmation then works 30 ms and asks
   * for a region (requestState "s2"); the final round works 20 ms. A decline
   * ends with "cancelled by user". `stateOnly`: round 1 returns a
   * requestState-only result (load shedding). `badOutput`: the final result
   * violates the declared outputSchema. `throwFinal`: the final round throws.
   * `urlAfterConfirm`: a confirmation is answered with a URL elicitation
   * (`-32042`, 2025 era).
   */
  function registerDeploy(server: McpServer, opts: DeployOptions = {}, runs = { n: 0 }) {
    if (opts.afterRound1 && runs.n > 0) {
      if (opts.afterRound1 === "schema_changed") {
        server.registerTool("deploy", { inputSchema: z.object({ env: z.number() }) }, async () =>
          ok("deployed"),
        );
      } else if (opts.afterRound1 === "disabled") {
        server
          .registerTool("deploy", { inputSchema: z.object({ env: z.string() }) }, async () =>
            ok("deployed"),
          )
          .disable();
      } else {
        // Another tool keeps tools/call registered: `deploy` is unknown, not the method.
        server.registerTool("status", { inputSchema: z.object({}) }, async () => ok("up"));
      }
      return runs;
    }
    const final = async (text: string) => {
      await sleep(20);
      if (opts.throwFinal) throw new Error("deploy backend down");
      return opts.badOutput
        ? { content: [{ type: "text" as const, text }], structuredContent: { deployed: "no" } }
        : ok(text);
    };
    const tool = server.registerTool(
      "deploy",
      {
        inputSchema: z.object({ env: z.string() }),
        ...(opts.badOutput ? { outputSchema: z.object({ deployed: z.boolean() }) } : {}),
      },
      async ({ env }, ctx) => {
        runs.n++;
        const responses = ctx.mcpReq.inputResponses;
        const state = ctx.mcpReq.requestState();
        if (opts.stateOnly) {
          if (state === "busy") return final(`deployed to ${env}`);
          await sleep(40);
          return inputRequired({ requestState: "busy" });
        }
        if (state === "s2") {
          const answer = acceptedContent(responses, "region", regionSchema);
          return final(answer ? `deployed to ${env} in ${answer.region}` : "cancelled by user");
        }
        if (!responses) {
          await sleep(40);
          if (opts.disableWhileAsking) tool.disable();
          const ask = inputRequired({
            inputRequests: {
              confirm: inputRequired.elicit({
                message: `Deploy to ${env}?`,
                requestedSchema: confirmSchema,
              }),
            },
          });
          return opts.interimIsError ? ({ ...ask, isError: true } as typeof ask) : ask;
        }
        if (acceptedContent(responses, "confirm", confirmSchema)?.confirm !== true) {
          await sleep(20);
          return ok("cancelled by user");
        }
        if (opts.urlAfterConfirm) {
          throw new UrlElicitationRequiredError([
            {
              mode: "url",
              message: "Approve the deployment",
              url: "https://approve.example.com/deploy",
              elicitationId: "approve-1",
            },
          ]);
        }
        if (opts.twoRounds) {
          await sleep(30);
          return inputRequired({
            inputRequests: {
              region: inputRequired.elicit({
                message: "Which region?",
                requestedSchema: regionSchema,
              }),
            },
            requestState: "s2",
          });
        }
        return final(`deployed to ${env}`);
      },
    );
    return runs;
  }

  /** A client that answers elicitations after THINK_MS: accepts, or declines. */
  function elicitingClient(
    opts: { action?: "accept" | "decline"; modern?: boolean; elicitation?: boolean } = {},
  ) {
    const { action = "accept", modern = true, elicitation = true } = opts;
    const client = new Client(
      { name: "mrtr-client", version: "1.0" },
      {
        ...(elicitation ? { capabilities: { elicitation: { form: {} } } } : {}),
        ...(modern ? { versionNegotiation: { mode: "auto" as const } } : {}),
      },
    );
    if (elicitation) {
      client.setRequestHandler("elicitation/create", async (request) => {
        await sleep(THINK_MS);
        if (action !== "accept") return { action };
        const fields = Object.keys(
          (request.params as { requestedSchema?: { properties?: object } }).requestedSchema
            ?.properties ?? {},
        );
        return {
          action: "accept" as const,
          content: (fields.includes("region") ? { region: "eu" } : { confirm: true }) as Record<
            string,
            string | boolean
          >,
        };
      });
    }
    return client;
  }

  /** A per-request HTTP host: 2026-07-28 for a negotiating client. */
  async function perRequestHost(
    opts: DeployOptions,
    serverOnly: boolean,
  ): Promise<{ url: URL; runs: { n: number }; yavio: ReturnType<typeof createYavio> }> {
    const yavio = createYavio({ apiKey: "yav_mrtr", endpoint: ingest.endpoint, serverOnly });
    const runs = { n: 0 };
    const nodeHandler = toNodeHandler(
      createMcpHandler(() => {
        const server = mrtrServer(opts);
        registerDeploy(server, opts, runs);
        return yavio.wrap(server);
      }),
    );
    const httpServer = createServer((req, res) => {
      void nodeHandler(req, res);
    });
    mcp = httpServer;
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const url = new URL(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`);
    return { url, runs, yavio };
  }

  /** One call against a per-request host; `bodies` holds every HTTP response body. */
  async function modernCall(
    opts: DeployOptions = {},
    clientOpts: Parameters<typeof elicitingClient>[0] = {},
    serverOnly = true,
  ) {
    const { url, runs, yavio } = await perRequestHost(opts, serverOnly);
    const bodies: string[] = [];
    const tap: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      bodies.push(await res.clone().text());
      return res;
    };
    const client = elicitingClient(clientOpts);
    await client.connect(new StreamableHTTPClientTransport(url, { fetch: tap }));
    const era = client.getNegotiatedProtocolVersion();
    const started = performance.now();
    const result = await client
      .callTool({
        name: "deploy",
        arguments: { env: "prod" },
        _meta: { "openai/session": "conv-mrtr" },
      })
      .catch((error: unknown) => error);
    const wallMs = performance.now() - started;
    await client.close();
    await yavio.shutdown();
    return {
      result,
      era,
      runs: runs.n,
      wallMs,
      bodies,
      calls: ingest.ofType("tool_call") as unknown as ToolCallEvent[],
    };
  }

  /** One call over InMemoryTransport (2025 era, the shim); `results` holds the tool results the server sent. */
  async function shimCall(
    opts: DeployOptions = {},
    clientOpts: Parameters<typeof elicitingClient>[0] = {},
    serverOnly = true,
  ) {
    const yavio = createYavio({ apiKey: "yav_mrtr_shim", endpoint: ingest.endpoint, serverOnly });
    const server = mrtrServer(opts);
    const runs = registerDeploy(server, opts);
    const wrapped = yavio.wrap(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const sent: Array<{ result?: Record<string, unknown> }> = [];
    const send = serverTransport.send.bind(serverTransport);
    serverTransport.send = (message, options) => {
      sent.push(message as { result?: Record<string, unknown> });
      return send(message, options);
    };
    await wrapped.connect(serverTransport);
    const client = elicitingClient({ modern: false, ...clientOpts });
    await client.connect(clientTransport);
    const era = client.getNegotiatedProtocolVersion();
    const started = performance.now();
    const result = await client
      .callTool({ name: "deploy", arguments: { env: "prod" } })
      .catch((error: unknown) => error);
    const wallMs = performance.now() - started;
    await client.close();
    await yavio.shutdown();
    const results = sent.filter((m) => m.result && "content" in m.result).map((m) => m.result);
    return {
      result,
      era,
      runs: runs.n,
      wallMs,
      results,
      calls: ingest.ofType("tool_call") as unknown as ToolCallEvent[],
    };
  }

  const text = (result: unknown) =>
    (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  const outputText = (event: ToolCallEvent | undefined) =>
    (event?.output_content as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]
      ?.text;

  describe("2026-07-28, a per-request host", () => {
    it("an accepted confirmation: one event, from the final round, marked as a retry; the think time is in no latency", async () => {
      const call = await modernCall();
      expect(call.era).toBe("2026-07-28");
      expect(call.runs).toBe(2);
      expect(text(call.result)).toBe("deployed to prod");
      expect(call.calls).toHaveLength(1);
      const [event] = call.calls;
      expect(event?.status).toBe("success");
      expect(outputText(event)).toBe("deployed to prod");
      expect(event?.metadata).toEqual({ input_retry: true });
      // The final request's handler time only: the first round was another
      // request, and the user's answer came between them.
      expect(event?.latency_ms).toBeLessThan(call.wallMs - THINK_MS);
    });

    it("a declined confirmation: one event, with the status the tool's final result gives", async () => {
      const call = await modernCall({}, { action: "decline" });
      expect(text(call.result)).toBe("cancelled by user");
      expect(call.calls).toHaveLength(1);
      expect(call.calls[0]?.status).toBe("success");
      expect(outputText(call.calls[0])).toBe("cancelled by user");
      expect(call.calls[0]?.metadata).toEqual({ input_retry: true });
    });

    it("two input rounds (three requests): one event", async () => {
      const call = await modernCall({ twoRounds: true });
      expect(call.runs).toBe(3);
      expect(text(call.result)).toBe("deployed to prod in eu");
      expect(call.calls).toHaveLength(1);
      expect(outputText(call.calls[0])).toBe("deployed to prod in eu");
      expect(call.calls[0]?.metadata).toEqual({ input_retry: true });
    });

    it("a requestState-only interim result: one event", async () => {
      const call = await modernCall({ stateOnly: true });
      expect(call.runs).toBe(2);
      expect(call.calls).toHaveLength(1);
      expect(call.calls[0]?.metadata).toEqual({ input_retry: true });
    });

    it("a failure of the final round lands on the one event: a throw is unknown, an output-schema failure server", async () => {
      const thrown = await modernCall({ throwFinal: true });
      expect(thrown.calls).toHaveLength(1);
      expect(thrown.calls[0]?.error_category).toBe("unknown");
      expect(thrown.calls[0]?.metadata).toEqual({ input_retry: true });
      _resetGlobalState();
      ingest.events.length = 0;
      const invalid = await modernCall({ badOutput: true });
      expect(invalid.calls).toHaveLength(1);
      expect(invalid.calls[0]?.status).toBe("error");
      expect(invalid.calls[0]?.error_category).toBe("server");
      expect(outputText(invalid.calls[0])).toBe("deployed to prod");
    });

    it("v2 refusing the input request (the client declared no elicitation) is still one server error", async () => {
      const call = await modernCall({}, { elicitation: false });
      expect(call.result).toBeInstanceOf(Error);
      expect(call.calls).toHaveLength(1);
      expect(call.calls[0]?.status).toBe("error");
      expect(call.calls[0]?.error_category).toBe("server");
      expect(call.calls[0]?.metadata).toEqual({ input_rounds: 1 });
    });

    it("serverOnly false: the interim result goes out without _meta.yavio, the final one carries it for the event's trace", async () => {
      const call = await modernCall({}, {}, false);
      expect(call.calls).toHaveLength(1);
      const interim = call.bodies.filter((body) => body.includes("input_required"));
      expect(interim).toHaveLength(1);
      expect(interim[0]).not.toContain('"yavio"');
      expect(
        (call.result as { _meta?: { yavio?: { traceId?: string } } })._meta?.yavio?.traceId,
      ).toBe(call.calls[0]?.trace_id);
    });

    it("an interim result that also carries isError: true is still interim: one event, from the final round", async () => {
      const call = await modernCall({ interimIsError: true });
      expect(call.runs).toBe(2);
      expect(text(call.result)).toBe("deployed to prod");
      expect(call.calls).toHaveLength(1);
      expect(call.calls[0]?.status).toBe("success");
      expect(call.calls[0]?.metadata).toEqual({ input_retry: true });
    });

    it("a retry whose requestState the server's verify hook refuses (-32602 before the handler) is one server error, marked as a retry", async () => {
      const call = await modernCall({ stateOnly: true, rejectState: true });
      expect(call.era).toBe("2026-07-28");
      expect(call.runs).toBe(1);
      expect(call.result).toBeInstanceOf(Error);
      expect(String(call.result)).toContain("Invalid or expired requestState");
      expect(call.calls).toHaveLength(1);
      const [event] = call.calls;
      expect(event?.status).toBe("error");
      expect(event?.error_category).toBe("server");
      expect(event?.error_message).toBe("Invalid or expired requestState");
      // Nothing ran in the retry request.
      expect(event?.latency_ms).toBeUndefined();
      expect(event?.metadata).toEqual({ input_retry: true });
      // Nothing validated the retry's arguments: stored like a rejected call's.
      expect(event?.input_keys).toEqual({ env: true });
      expect(event?.input_values).not.toHaveProperty("env");
    });

    it("a retry the MCP SDK rejects before the handler (the tool changed, vanished or was disabled between the rounds) is one server error, marked as a retry, as on the shim", async () => {
      const changed = await modernCall({ afterRound1: "schema_changed" });
      expect(changed.runs).toBe(1);
      expect((changed.result as { isError?: boolean }).isError).toBe(true);
      expect(changed.calls).toHaveLength(1);
      expect(changed.calls[0]?.status).toBe("error");
      expect(changed.calls[0]?.error_category).toBe("server");
      expect(changed.calls[0]?.latency_ms).toBeUndefined();
      expect(changed.calls[0]?.metadata).toEqual({ input_retry: true });
      for (const afterRound1 of ["removed", "disabled"] as const) {
        _resetGlobalState();
        ingest.events.length = 0;
        const call = await modernCall({ afterRound1 });
        expect(call.runs).toBe(1);
        expect(call.calls).toHaveLength(1);
        expect(call.calls[0]?.error_category).toBe("server");
        expect(call.calls[0]?.error_message).toBe(
          afterRound1 === "removed" ? "Tool deploy not found" : "Tool deploy disabled",
        );
        expect(call.calls[0]?.metadata).toEqual({ input_retry: true });
      }
    });

    it("a 2025-era client against a per-request host: the shim has no channel, one server error as before", async () => {
      const call = await modernCall({}, { modern: false });
      expect(call.era).toMatch(/^2025-/);
      expect((call.result as { isError?: boolean }).isError).toBe(true);
      expect(call.calls).toHaveLength(1);
      expect(call.calls[0]?.error_category).toBe("server");
      expect(call.calls[0]?.metadata).toEqual({ input_rounds: 1 });
    });
  });

  describe("2025 era, v2's legacy shim on a long-lived connection", () => {
    it("an accepted confirmation: one event with the final output, every round's handler time and none of the think time", async () => {
      const call = await shimCall();
      expect(call.era).toMatch(/^2025-/);
      expect(call.runs).toBe(2);
      expect(text(call.result)).toBe("deployed to prod");
      expect(call.calls).toHaveLength(1);
      const [event] = call.calls;
      expect(event?.status).toBe("success");
      expect(outputText(event)).toBe("deployed to prod");
      expect(event?.metadata).toEqual({ input_rounds: 1 });
      // 40 ms + 20 ms of handler time, not the 20 ms of the last round.
      expect(event?.latency_ms).toBeGreaterThanOrEqual(55);
      expect(event?.latency_ms).toBeLessThan(call.wallMs - THINK_MS);
    });

    it("two input rounds: one event, input_rounds 2", async () => {
      const call = await shimCall({ twoRounds: true });
      expect(call.runs).toBe(3);
      expect(call.calls).toHaveLength(1);
      expect(outputText(call.calls[0])).toBe("deployed to prod in eu");
      expect(call.calls[0]?.metadata).toEqual({ input_rounds: 2 });
    });

    it("a declined confirmation: one event, status from the final result", async () => {
      const call = await shimCall({}, { action: "decline" });
      expect(call.calls).toHaveLength(1);
      expect(call.calls[0]?.status).toBe("success");
      expect(outputText(call.calls[0])).toBe("cancelled by user");
    });

    it("the final round's output-schema failure lands on the one event, not on an interim one", async () => {
      const call = await shimCall({ badOutput: true });
      expect((call.result as { isError?: boolean }).isError).toBe(true);
      expect(call.calls).toHaveLength(1);
      expect(call.calls[0]?.status).toBe("error");
      expect(call.calls[0]?.error_category).toBe("server");
      expect(outputText(call.calls[0])).toBe("deployed to prod");
    });

    it("a throw in the final round is one error, not two", async () => {
      const call = await shimCall({ throwFinal: true });
      expect(call.calls).toHaveLength(1);
      expect(call.calls[0]?.error_category).toBe("unknown");
      expect(call.calls[0]?.metadata).toEqual({ input_rounds: 1 });
    });

    it("the shim refusing (the client declared no elicitation) is one server error", async () => {
      const call = await shimCall({}, { elicitation: false });
      expect(call.calls).toHaveLength(1);
      expect(call.calls[0]?.error_category).toBe("server");
      expect(call.calls[0]?.metadata).toEqual({ input_rounds: 1 });
    });

    it("the verify hook refusing the round's requestState is one server error, as on 2026-07-28", async () => {
      const call = await shimCall({ stateOnly: true, rejectState: true });
      expect(call.runs).toBe(1);
      expect(call.result).toBeInstanceOf(Error);
      expect(call.calls).toHaveLength(1);
      const [event] = call.calls;
      expect(event?.status).toBe("error");
      expect(event?.error_category).toBe("server");
      expect(event?.error_message).toBe("Invalid or expired requestState");
      expect(event?.metadata).toEqual({ input_rounds: 1 });
      // Round 1 ran (40 ms) in this request.
      expect(event?.latency_ms).toBeGreaterThanOrEqual(35);
    });

    it("the tool disabled while the shim waits for the answer is one server error, as on 2026-07-28", async () => {
      const call = await shimCall({ disableWhileAsking: true });
      expect(call.runs).toBe(1);
      expect(call.calls).toHaveLength(1);
      expect(call.calls[0]?.status).toBe("error");
      expect(call.calls[0]?.error_category).toBe("server");
      expect(call.calls[0]?.metadata).toEqual({ input_rounds: 1 });
    });

    it("a URL elicitation after an interim round leaves no event: the client retries the call after the URL flow", async () => {
      const call = await shimCall({ urlAfterConfirm: true });
      expect(call.runs).toBe(2);
      expect((call.result as { code?: unknown }).code).toBe(-32042);
      expect(call.calls).toHaveLength(0);
    });

    it("serverOnly false: the one result on the wire carries _meta.yavio for the event's trace", async () => {
      const call = await shimCall({}, {}, false);
      expect(call.calls).toHaveLength(1);
      expect(call.results).toHaveLength(1);
      expect((call.results[0]?._meta as { yavio?: { traceId?: string } }).yavio?.traceId).toBe(
        call.calls[0]?.trace_id,
      );
    });
  });

  it("only v2's requestState refusal (data.reason invalid_request_state) makes a thrown InvalidParams on a retry an event", async () => {
    // A stand-in for v2's stored tools/call handler, wrapped in place by the
    // proxy, called with a retry context: what it throws is all that differs.
    const server = new McpServer({ name: "throws", version: "1.0" });
    const low = (
      server as unknown as {
        server: { _requestHandlers: Map<string, (req: unknown, ctx: unknown) => Promise<unknown>> };
      }
    ).server;
    let toThrow: Error = new Error("unset");
    low._requestHandlers.set("tools/call", async () => {
      throw toThrow;
    });
    const transport = createMockTransport();
    createProxy(server, makeConfig({ endpoint: ingest.endpoint }), transport, "0.5.5");
    const call = (error: Error) => {
      toThrow = error;
      return low._requestHandlers
        .get("tools/call")?.(
          { method: "tools/call", params: { name: "deploy", arguments: { env: "prod" } } },
          {
            mcpReq: {
              id: 7,
              method: "tools/call",
              _meta: { "openai/session": "conv-throws" },
              inputResponses: { confirm: { action: "accept", content: { confirm: true } } },
              requestState: () => undefined,
            },
          },
        )
        .catch((thrown: unknown) => thrown);
    };

    // Any other InvalidParams the MCP SDK throws before the handler is not
    // the proxy's to classify, retry or not.
    const other = Object.assign(new Error("Invalid tools/call request: x"), { code: -32602 });
    expect(await call(other)).toBe(other);
    expect(toolCalls(transport.sent)).toHaveLength(0);

    // The control: the same path with v2's refusal sends one server event.
    const refused = Object.assign(new Error("Invalid or expired requestState"), {
      code: -32602,
      data: { reason: "invalid_request_state" },
    });
    expect(await call(refused)).toBe(refused);
    const events = toolCalls(transport.sent);
    expect(events).toHaveLength(1);
    expect(events[0]?.error_category).toBe("server");
    expect(events[0]?.metadata).toEqual({ input_retry: true });
  });

  it("an interim result reaches the client byte-identical, also without serverOnly (direct handler call)", async () => {
    // No frame (the handler is called directly): the callback wrapper alone
    // must leave an InputRequiredResult as the handler built it.
    const server = new McpServer({ name: "direct", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(
      server,
      makeConfig({ serverOnly: false, endpoint: ingest.endpoint }),
      transport,
      "0.5.5",
    );
    const interim = inputRequired({ requestState: "opaque" });
    const before = JSON.stringify(interim);
    proxy.registerTool("deploy", { inputSchema: { env: z.string() } }, async () => interim);
    const handler = registeredTool(server, "deploy")?.handler;
    if (!handler) throw new Error("deploy is not registered");
    const returned = await handler({ env: "prod" }, { mcpReq: { id: 1, method: "tools/call" } });
    expect(returned).toBe(interim);
    expect(JSON.stringify(returned)).toBe(before);
    expect(toolCalls(transport.sent)).toHaveLength(0);
  });
});

// #173: SEP-414 trace context, sent the way a 2026-07-28 client sends it —
// with the v2 package's own `_meta` key names (exported since 2.0.0).
describe("MCP SDK v2 — SEP-414 trace context in _meta (#173)", () => {
  const META_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const HEADER_TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  const traceMeta = {
    "openai/locale": "de-DE",
    [TRACEPARENT_META_KEY]: META_TRACEPARENT,
    [TRACESTATE_META_KEY]: "congo=t61rcWkgMzE",
    [BAGGAGE_META_KEY]: "user.id=u-48213,tenant.id=acme-gmbh",
  };
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
  });

  const buildServer = () => {
    const server = new McpServer({ name: "trace-v2", version: "1.0" });
    server.registerTool(
      "get_price",
      { description: "d", inputSchema: { sku: z.string() } },
      async ({ sku }) => ok(`price of ${sku}`),
    );
    return server;
  };

  function expectTraceContext(call: Record<string, unknown> | undefined, traceparent: string) {
    expect(call?.metadata).toEqual({ traceparent });
    const inputValues = call?.input_values as Record<string, unknown>;
    expect(inputValues._meta).toEqual({ "openai/locale": "de-DE" });
    expect(inputValues._metaDroppedKeys).toEqual(["baggage", "tracestate"]);
    const serialized = leakScan(call);
    for (const value of ["u-48213", "acme-gmbh", "t61rcWkgMzE"]) {
      expect(serialized, value).not.toContain(value);
    }
  }

  it("2026-07-28 per-request host: the _meta traceparent is metadata.traceparent, no baggage is stored, a rejected call keeps it too", async () => {
    // Defaults: capture.geo true, where _meta was kept verbatim before.
    const yavio = createYavio({
      apiKey: "yav_v2_trace",
      endpoint: ingest.endpoint,
      serverOnly: true,
    });
    const nodeHandler = toNodeHandler(createMcpHandler(() => yavio.wrap(buildServer())));
    const httpServer = createServer((req, res) => {
      void nodeHandler(req, res);
    });
    mcp = httpServer;
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const url = new URL(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`);
    const client = new Client(
      { name: "trace-client", version: "1.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    // An HTTP hop's own traceparent on every request: the _meta one wins.
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { traceparent: HEADER_TRACEPARENT } },
      }),
    );
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    await client.callTool({ name: "get_price", arguments: { sku: "A1" }, _meta: traceMeta });
    const rejected = await client.callTool({
      name: "get_price",
      arguments: { sku: 42 },
      _meta: traceMeta,
    });
    expect(rejected.isError).toBe(true);
    await client.close();
    await yavio.shutdown();

    const [call, validation] = ingest.events.filter((e) => e.event_type === "tool_call");
    expectTraceContext(call, META_TRACEPARENT);
    expect(validation?.error_category).toBe("validation");
    expectTraceContext(validation, META_TRACEPARENT);
    // Stored once: the header copy is gone from _requestInfo.
    const requestInfo = (call?.input_values as { _requestInfo?: { headers?: object } })
      ._requestInfo;
    expect(requestInfo?.headers).not.toHaveProperty("traceparent");
    expect(leakScan({ ...call, metadata: undefined })).not.toContain("0af7651916cd43dd");
  });

  it("2026-07-28 over serveStdio: _meta is the only carrier, and the traceparent survives", async () => {
    const yavio = createYavio({
      apiKey: "yav_v2_trace_stdio",
      endpoint: ingest.endpoint,
      serverOnly: true,
    });
    // serveStdio over a caller-supplied transport: the stdio entry with its
    // era decision, no HTTP request anywhere.
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => yavio.wrap(buildServer()), { transport: serverTransport });
    const client = new Client(
      { name: "trace-client", version: "1.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(clientTransport);
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    await client.callTool({ name: "get_price", arguments: { sku: "A1" }, _meta: traceMeta });
    await client.close();
    await handle.close();
    await yavio.shutdown();

    const [call] = ingest.events.filter((e) => e.event_type === "tool_call");
    expectTraceContext(call, META_TRACEPARENT);
    expect(call?.input_values).not.toHaveProperty("_requestInfo");
  });
});

describe("MCP SDK v2 — server-to-client requests from a handler, by era (#172)", () => {
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

  /** v2's guard (`_assertPushApiInServedEra`), which steers to `inputRequired()`. */
  const NOT_ON_2026 =
    /^Server-to-client requests are not available on protocol revision 2026-07-28: '(elicitation\/create|sampling\/createMessage|roots\/list|ping)' cannot be sent while serving a request on that revision\. Return inputRequired\(/;
  const TOOLS = ["confirm", "summarize", "roots", "ping"] as const;
  const firstText = (result: unknown) =>
    (result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text;

  /** One tool per push-style API; each returns what the client answered. */
  const buildServer = () => {
    const server = new McpServer({ name: "push-v2", version: "1.0" });
    server.registerTool("confirm", { inputSchema: z.object({}) }, async (_args, ctx) => {
      const answer = await ctx.mcpReq.elicitInput({
        message: "Deploy to prod?",
        requestedSchema: { type: "object", properties: { confirm: { type: "boolean" } } },
      });
      return ok(JSON.stringify(answer));
    });
    server.registerTool("summarize", { inputSchema: z.object({}) }, async (_args, ctx) => {
      const answer = await ctx.mcpReq.requestSampling({
        messages: [{ role: "user", content: { type: "text", text: "Summarize" } }],
        maxTokens: 10,
      });
      return ok(JSON.stringify(answer));
    });
    server.registerTool("roots", { inputSchema: z.object({}) }, async () =>
      ok(JSON.stringify(await server.server.listRoots())),
    );
    server.registerTool("ping", { inputSchema: z.object({}) }, async () =>
      ok(JSON.stringify(await server.server.ping())),
    );
    return server;
  };

  /** A client that declares and answers elicitation, sampling and roots. */
  function answeringClient(negotiate: boolean) {
    const client = new Client(
      { name: "push-client", version: "1.0" },
      {
        capabilities: { elicitation: { form: {} }, sampling: {}, roots: {} },
        ...(negotiate ? { versionNegotiation: { mode: "auto" as const } } : {}),
      },
    );
    client.setRequestHandler("elicitation/create", async () => ({
      action: "accept" as const,
      content: { confirm: true },
    }));
    client.setRequestHandler("sampling/createMessage", async () => ({
      role: "assistant" as const,
      content: { type: "text" as const, text: "a summary" },
      model: "test-model",
    }));
    client.setRequestHandler("roots/list", async () => ({
      roots: [{ uri: "file:///work", name: "work" }],
    }));
    return client;
  }

  type Entry = "createMcpHandler" | "serveStdio" | "connect";

  /** Calls each tool once through `entry`: the era, the results, the tool_call events. */
  async function callAll(entry: Entry, negotiate: boolean, tools: readonly string[] = TOOLS) {
    const yavio = createYavio({
      apiKey: `yav_push_${entry}`,
      endpoint: ingest.endpoint,
      serverOnly: true,
    });
    const client = answeringClient(negotiate);
    let closeServer = async () => {};
    if (entry === "createMcpHandler") {
      const nodeHandler = toNodeHandler(createMcpHandler(() => yavio.wrap(buildServer())));
      const httpServer = createServer((req, res) => {
        void nodeHandler(req, res);
      });
      mcp = httpServer;
      await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
      const url = new URL(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`);
      await client.connect(new StreamableHTTPClientTransport(url));
    } else {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      if (entry === "serveStdio") {
        // The stdio entry with its era decision, over a caller-supplied transport.
        const handle = serveStdio(() => yavio.wrap(buildServer()), { transport: serverTransport });
        closeServer = () => handle.close();
      } else {
        await yavio.wrap(buildServer()).connect(serverTransport);
      }
      await client.connect(clientTransport);
    }
    const era = client.getNegotiatedProtocolVersion();
    const results = [];
    for (const name of tools) results.push(await client.callTool({ name, arguments: {} }));
    await client.close();
    await closeServer();
    await yavio.shutdown();
    return { era, results, calls: ingest.ofType("tool_call") as unknown as ToolCallEvent[] };
  }

  it.each(["createMcpHandler", "serveStdio"] as const)(
    "on 2026-07-28 (%s) elicitInput(), requestSampling(), listRoots() and ping() throw: the client gets isError, each call is one error / unknown event",
    async (entry) => {
      const { era, results, calls } = await callAll(entry, true);
      expect(era).toBe("2026-07-28");
      expect(results).toHaveLength(4);
      for (const result of results) {
        expect(result.isError).toBe(true);
        expect(firstText(result)).toMatch(NOT_ON_2026);
      }
      expect(calls.map((e) => e.event_name)).toEqual([...TOOLS]);
      for (const call of calls) {
        expect(call.status).toBe("error");
        expect(call.error_category).toBe("unknown");
        expect(call.error_message).toMatch(NOT_ON_2026);
        // A handler that threw, not a call that asked for input.
        expect(call.metadata ?? {}).not.toHaveProperty("input_rounds");
        expect(call.metadata ?? {}).not.toHaveProperty("input_retry");
      }
    },
  );

  it("on the 2025 era over InMemoryTransport the same handlers reach the client: one success event per call, with the answer", async () => {
    // connect() stays on 2025-11-25 even for a client that asks for 2026-07-28.
    const { era, results, calls } = await callAll("connect", true);
    expect(era).toBe("2025-11-25");
    expect(results.map((r) => r.isError)).toEqual([undefined, undefined, undefined, undefined]);
    expect(JSON.parse(firstText(results[0]) ?? "")).toEqual({
      action: "accept",
      content: { confirm: true },
    });
    expect(JSON.parse(firstText(results[1]) ?? "")).toMatchObject({
      content: { text: "a summary" },
    });
    expect(JSON.parse(firstText(results[2]) ?? "")).toEqual({
      roots: [{ uri: "file:///work", name: "work" }],
    });
    expect(calls.map((e) => [e.event_name, e.status])).toEqual(
      TOOLS.map((name) => [name, "success"]),
    );
    expect(firstText(calls[0]?.output_content)).toBe(firstText(results[0]));
  });

  it("a 2025-era client of a per-request host: elicitInput() fails at once, one error / unknown event", async () => {
    // The instance serving tools/call never saw initialize, so v2 knows no
    // elicitation capability. (requestSampling(), listRoots() and ping()
    // have no channel back either: they wait for v2's request timeout.)
    const { era, results, calls } = await callAll("createMcpHandler", false, ["confirm"]);
    expect(era).toBe("2025-11-25");
    expect(results[0]?.isError).toBe(true);
    expect(firstText(results[0])).toMatch(/does not support/);
    expect(calls.map((e) => [e.event_name, e.status, e.error_category])).toEqual([
      ["confirm", "error", "unknown"],
    ]);
  });
});
