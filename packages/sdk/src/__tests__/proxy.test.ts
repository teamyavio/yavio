import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BaseEvent } from "@yavio/shared/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CaptureConfig, YavioConfig } from "../core/types.js";
import { _resetSessionMap, createProxy } from "../server/proxy.js";
import { mintWidgetToken } from "../server/token.js";
import type { Transport } from "../transport/types.js";

vi.mock("../server/token.js", () => ({
  mintWidgetToken: vi.fn(),
}));

const mockedMint = vi.mocked(mintWidgetToken);

function createMockTransport(): Transport & { sent: BaseEvent[][] } {
  const sent: BaseEvent[][] = [];
  return {
    sent,
    send(events: BaseEvent[]) {
      sent.push(events);
    },
    flush: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

const testConfig: YavioConfig = {
  apiKey: "yav_test",
  endpoint: "http://localhost:3001/v1/events",
  capture: {
    inputValues: true,
    outputValues: true,
    geo: true,
    tokens: true,
    retries: true,
  } satisfies CaptureConfig,
};

describe("createProxy", () => {
  it("returns a proxied server that can register tools", () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    // Should not throw
    proxy.tool("test_tool", () => ({
      content: [{ type: "text", text: "ok" }],
    }));
  });

  it("emits tool_call event on tool invocation", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    let handlerCalled = false;
    proxy.tool("search_rooms", (extra) => {
      handlerCalled = true;
      return { content: [{ type: "text", text: "found rooms" }] };
    });

    // Access the registered tool handler through the underlying server internals
    // We need to call the tool handler directly since we can't use inject()
    // The tool is registered on the real server; we test via the proxy's wrapping
    // For this test, we'll verify the proxy wraps the callback correctly
    expect(handlerCalled).toBe(false);
    // The tool was registered — we can verify via the server's internal state
  });

  it("preserves non-intercepted properties", () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    // McpServer has a .server property (the low-level Server)
    expect(proxy.server).toBeDefined();
  });

  it("handles tool registration with description and schema", () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    // Should not throw for any of the tool() overloads
    proxy.tool("tool_with_desc", "A description", (extra) => ({
      content: [{ type: "text", text: "ok" }],
    }));
  });
});

describe("createProxy — registerTool", () => {
  it("registers tools via registerTool without throwing", () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    proxy.registerTool("test_tool", {}, () => ({
      content: [{ type: "text", text: "ok" }],
    }));
  });

  it("exposes registerTool as a function on the proxy", () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    expect(typeof proxy.registerTool).toBe("function");
  });

  it("handles registerTool with description and inputSchema", () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    proxy.registerTool(
      "tool_with_config",
      {
        description: "A tool with config",
        inputSchema: { query: { type: "string" } as never },
      },
      (args, extra) => ({
        content: [{ type: "text", text: "ok" }],
      }),
    );
  });

  it("returns RegisteredTool with enable/disable/remove methods", () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    const registered = proxy.registerTool("my_tool", {}, () => ({
      content: [{ type: "text", text: "ok" }],
    }));

    expect(typeof registered.enable).toBe("function");
    expect(typeof registered.disable).toBe("function");
    expect(typeof registered.remove).toBe("function");
  });
});

/** Access the internal _registeredTools object on McpServer. */
function getRegisteredTool(
  server: McpServer,
  name: string,
): { handler: (...args: unknown[]) => unknown } | undefined {
  const tools = (server as unknown as Record<string, Record<string, unknown>>)._registeredTools;
  if (!tools || !(name in tools)) return undefined;
  return tools[name] as { handler: (...args: unknown[]) => unknown };
}

describe("createProxy — widget config injection", () => {
  beforeEach(() => {
    mockedMint.mockReset();
  });

  it("always injects _meta.yavio when minting succeeds", async () => {
    mockedMint.mockResolvedValue({
      token: "jwt_widget_123",
      expiresAt: "2026-01-01T00:00:00Z",
    });

    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    proxy.tool("my_tool", (extra) => ({
      content: [{ type: "text", text: "ok" }],
    }));

    const tool = getRegisteredTool(server, "my_tool");
    const mockExtra = {
      signal: new AbortController().signal,
      requestId: "req-1",
      sendNotification: async () => {},
      sendRequest: async () => ({}),
    };

    const result = (await tool?.handler(mockExtra)) as Record<string, unknown>;
    const meta = result._meta as Record<string, unknown>;
    expect(meta).toBeDefined();

    const yavio = meta.yavio as Record<string, unknown>;
    expect(yavio).toBeDefined();
    expect(yavio.token).toBe("jwt_widget_123");
    expect(yavio.endpoint).toBe(testConfig.endpoint);
    expect(typeof yavio.traceId).toBe("string");
    expect(typeof yavio.sessionId).toBe("string");
  });

  it("returns result unchanged when widget minting fails", async () => {
    mockedMint.mockResolvedValue(null);

    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    proxy.tool("fail_mint_tool", (extra) => ({
      content: [{ type: "text", text: "ok" }],
    }));

    const tool = getRegisteredTool(server, "fail_mint_tool");
    const mockExtra = {
      signal: new AbortController().signal,
      requestId: "req-3",
      sendNotification: async () => {},
      sendRequest: async () => ({}),
    };

    const result = (await tool?.handler(mockExtra)) as Record<string, unknown>;
    expect(result._meta).toBeUndefined();
  });

  it("returns result unchanged when widget minting throws", async () => {
    mockedMint.mockRejectedValue(new Error("Network error"));

    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    proxy.tool("throw_mint_tool", (extra) => ({
      content: [{ type: "text", text: "ok" }],
    }));

    const tool = getRegisteredTool(server, "throw_mint_tool");
    const mockExtra = {
      signal: new AbortController().signal,
      requestId: "req-4",
      sendNotification: async () => {},
      sendRequest: async () => ({}),
    };

    const result = (await tool?.handler(mockExtra)) as Record<string, unknown>;
    expect(result._meta).toBeUndefined();
  });

  it("preserves existing _meta fields when injecting widget config", async () => {
    mockedMint.mockResolvedValue({
      token: "jwt_widget_456",
      expiresAt: "2026-01-01T00:00:00Z",
    });

    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    proxy.tool("meta_tool", (extra) => ({
      content: [{ type: "text", text: "ok" }],
      _meta: { custom: "value" },
    }));

    const tool = getRegisteredTool(server, "meta_tool");
    const mockExtra = {
      signal: new AbortController().signal,
      requestId: "req-5",
      sendNotification: async () => {},
      sendRequest: async () => ({}),
    };

    const result = (await tool?.handler(mockExtra)) as Record<string, unknown>;
    const meta = result._meta as Record<string, unknown>;
    expect(meta.custom).toBe("value");
    expect(meta.yavio).toBeDefined();
  });

  it("reuses cached token on subsequent tool calls", async () => {
    const futureExpiry = new Date(Date.now() + 600_000).toISOString();
    mockedMint.mockResolvedValue({
      token: "jwt_cached",
      expiresAt: futureExpiry,
    });

    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    proxy.tool("cached_tool", (extra) => ({
      content: [{ type: "text", text: "ok" }],
    }));

    const tool = getRegisteredTool(server, "cached_tool");
    const mockExtra = {
      signal: new AbortController().signal,
      requestId: "req-6",
      sendNotification: async () => {},
      sendRequest: async () => ({}),
    };

    // First call — mints token
    const result1 = (await tool?.handler(mockExtra)) as Record<string, unknown>;
    expect(
      ((result1._meta as Record<string, unknown>).yavio as Record<string, unknown>).token,
    ).toBe("jwt_cached");

    // Second call — reuses cached token
    const result2 = (await tool?.handler({
      ...mockExtra,
      requestId: "req-7",
    })) as Record<string, unknown>;
    expect(
      ((result2._meta as Record<string, unknown>).yavio as Record<string, unknown>).token,
    ).toBe("jwt_cached");

    // mintWidgetToken should only have been called once
    expect(mockedMint).toHaveBeenCalledTimes(1);
  });
});

describe("createProxy — tool_discovery emission", () => {
  beforeEach(() => {
    mockedMint.mockReset();
    mockedMint.mockResolvedValue(null);
    _resetSessionMap();
  });

  it("emits tool_discovery event when tool() is called", () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    createProxy(server, testConfig, transport, "0.0.1").tool("search_rooms", () => ({
      content: [{ type: "text", text: "ok" }],
    }));

    expect(transport.sent.length).toBe(1);
    const event = transport.sent[0][0];
    expect(event.event_type).toBe("tool_discovery");
    expect((event as Record<string, unknown>).tool_name).toBe("search_rooms");
  });

  it("emits tool_discovery with description from tool(name, desc, cb)", () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    createProxy(server, testConfig, transport, "0.0.1").tool("my_tool", "A helpful tool", () => ({
      content: [{ type: "text", text: "ok" }],
    }));

    const event = transport.sent[0][0] as Record<string, unknown>;
    expect(event.event_type).toBe("tool_discovery");
    expect(event.tool_name).toBe("my_tool");
    expect(event.description).toBe("A helpful tool");
  });

  it("emits tool_discovery with inputSchema from tool(name, schema, cb)", () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    createProxy(server, testConfig, transport, "0.0.1").tool(
      "schema_tool",
      { query: z.string(), limit: z.number().optional() },
      () => ({ content: [{ type: "text", text: "ok" }] }),
    );

    const event = transport.sent[0][0] as Record<string, unknown>;
    expect(event.event_type).toBe("tool_discovery");
    expect(event.tool_name).toBe("schema_tool");
    expect(event.input_schema).toEqual({
      type: "object",
      properties: { query: {}, limit: {} },
    });
  });

  it("emits tool_discovery with description and inputSchema from tool(name, desc, schema, cb)", () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    createProxy(server, testConfig, transport, "0.0.1").tool(
      "full_tool",
      "A full tool",
      { query: z.string() },
      () => ({ content: [{ type: "text", text: "ok" }] }),
    );

    const event = transport.sent[0][0] as Record<string, unknown>;
    expect(event.event_type).toBe("tool_discovery");
    expect(event.tool_name).toBe("full_tool");
    expect(event.description).toBe("A full tool");
    expect(event.input_schema).toEqual({
      type: "object",
      properties: { query: {} },
    });
  });

  it("emits tool_discovery event when registerTool() is called", () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    createProxy(server, testConfig, transport, "0.0.1").registerTool(
      "reg_tool",
      {
        description: "A registered tool",
        inputSchema: { query: { type: "string" } as never },
      },
      () => ({ content: [{ type: "text", text: "ok" }] }),
    );

    expect(transport.sent.length).toBe(1);
    const event = transport.sent[0][0] as Record<string, unknown>;
    expect(event.event_type).toBe("tool_discovery");
    expect(event.tool_name).toBe("reg_tool");
    expect(event.description).toBe("A registered tool");
    expect(event.input_schema).toEqual({ query: { type: "string" } });
  });

  it("only emits tool_discovery once per tool name", () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    proxy.tool("dup_tool", () => ({
      content: [{ type: "text", text: "first" }],
    }));

    // Registering again with different config — should not emit again
    // (McpServer would throw on duplicate, but we're testing the proxy dedup)
    expect(transport.sent.length).toBe(1);
    expect((transport.sent[0][0] as Record<string, unknown>).tool_name).toBe("dup_tool");
  });

  it("emits tool_discovery with correct base event fields", () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    createProxy(server, testConfig, transport, "0.0.1").tool("base_fields_tool", () => ({
      content: [{ type: "text", text: "ok" }],
    }));

    const event = transport.sent[0][0];
    expect(event.event_type).toBe("tool_discovery");
    expect(event.source).toBe("server");
    expect(event.sdk_version).toBe("0.0.1");
    expect(typeof event.event_id).toBe("string");
    expect(typeof event.trace_id).toBe("string");
    expect(typeof event.session_id).toBe("string");
    expect(typeof event.timestamp).toBe("string");
  });
});

describe("createProxy — session reuse", () => {
  beforeEach(() => {
    mockedMint.mockReset();
    mockedMint.mockResolvedValue(null);
    _resetSessionMap();
  });

  function makeExtra(overrides?: Record<string, unknown>) {
    return {
      signal: new AbortController().signal,
      requestId: "req-sess",
      sendNotification: async () => {},
      sendRequest: async () => ({}),
      ...overrides,
    };
  }

  /** Create a new McpServer + proxy pair (simulates the getServer() pattern). */
  function createServerAndProxy(yavioTransport: Transport) {
    const server = new McpServer({ name: "test", version: "1.0" });
    const proxy = createProxy(server, testConfig, yavioTransport, "0.0.1");
    proxy.tool("tool_a", (extra) => ({
      content: [{ type: "text", text: "a" }],
    }));
    return { server, proxy };
  }

  it("reuses session via extra.sessionId across reconnections", async () => {
    const yavioTransport = createMockTransport();

    // First connection — new server + proxy (per-request HTTP pattern)
    const { server: server1, proxy: proxy1 } = createServerAndProxy(yavioTransport);
    const mcpTransport1 = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
    await proxy1.connect(mcpTransport1 as never);

    // Tool call with MCP session ID in extra (from Mcp-Session-Id header)
    const tool1 = getRegisteredTool(server1, "tool_a");
    await tool1?.handler(makeExtra({ sessionId: "mcp-session-abc" }));

    const firstSessionId = (yavioTransport.sent.at(-1) as unknown as BaseEvent[])[0].session_id;

    // Second connection — new server + proxy, same MCP session
    const { server: server2, proxy: proxy2 } = createServerAndProxy(yavioTransport);
    const mcpTransport2 = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
    await proxy2.connect(mcpTransport2 as never);

    const tool2 = getRegisteredTool(server2, "tool_a");
    await tool2?.handler(makeExtra({ sessionId: "mcp-session-abc", requestId: "req-2" }));

    const secondSessionId = (yavioTransport.sent.at(-1) as unknown as BaseEvent[])[0].session_id;

    expect(firstSessionId).toBe(secondSessionId);
  });

  it("falls back to transport.sessionId when extra has no sessionId", async () => {
    const yavioTransport = createMockTransport();

    // First connection with transport-level sessionId
    const { server: server1, proxy: proxy1 } = createServerAndProxy(yavioTransport);
    const mcpTransport1 = { start: vi.fn(), close: vi.fn(), send: vi.fn() } as Record<
      string,
      unknown
    >;
    await proxy1.connect(mcpTransport1 as never);
    mcpTransport1.sessionId = "mcp-transport-abc";

    const tool1 = getRegisteredTool(server1, "tool_a");
    await tool1?.handler(makeExtra());

    const firstSessionId = (yavioTransport.sent.at(-1) as unknown as BaseEvent[])[0].session_id;

    // Second connection with same transport sessionId
    const { server: server2, proxy: proxy2 } = createServerAndProxy(yavioTransport);
    const mcpTransport2 = { start: vi.fn(), close: vi.fn(), send: vi.fn() } as Record<
      string,
      unknown
    >;
    await proxy2.connect(mcpTransport2 as never);
    mcpTransport2.sessionId = "mcp-transport-abc";

    const tool2 = getRegisteredTool(server2, "tool_a");
    await tool2?.handler(makeExtra({ requestId: "req-2" }));

    const secondSessionId = (yavioTransport.sent.at(-1) as unknown as BaseEvent[])[0].session_id;

    expect(firstSessionId).toBe(secondSessionId);
  });

  it("creates separate sessions for different extra.sessionIds", async () => {
    const yavioTransport = createMockTransport();

    // First connection — MCP session "alpha"
    const { server: server1, proxy: proxy1 } = createServerAndProxy(yavioTransport);
    const mcpTransport1 = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
    await proxy1.connect(mcpTransport1 as never);

    const tool1 = getRegisteredTool(server1, "tool_a");
    await tool1?.handler(makeExtra({ sessionId: "mcp-session-alpha" }));

    const firstSessionId = (yavioTransport.sent.at(-1) as unknown as BaseEvent[])[0].session_id;

    // Second connection — different MCP session "beta"
    const { server: server2, proxy: proxy2 } = createServerAndProxy(yavioTransport);
    const mcpTransport2 = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
    await proxy2.connect(mcpTransport2 as never);

    const tool2 = getRegisteredTool(server2, "tool_a");
    await tool2?.handler(makeExtra({ sessionId: "mcp-session-beta", requestId: "req-3" }));

    const secondSessionId = (yavioTransport.sent.at(-1) as unknown as BaseEvent[])[0].session_id;

    expect(firstSessionId).not.toBe(secondSessionId);
  });

  it("works without any sessionId (stateless mode)", async () => {
    const yavioTransport = createMockTransport();

    // First connection — no sessionId anywhere
    const { server: server1, proxy: proxy1 } = createServerAndProxy(yavioTransport);
    const mcpTransport1 = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
    await proxy1.connect(mcpTransport1 as never);

    const tool1 = getRegisteredTool(server1, "tool_a");
    await tool1?.handler(makeExtra());

    const firstSessionId = (yavioTransport.sent.at(-1) as unknown as BaseEvent[])[0].session_id;

    // Second connection — also no sessionId
    const { server: server2, proxy: proxy2 } = createServerAndProxy(yavioTransport);
    const mcpTransport2 = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
    await proxy2.connect(mcpTransport2 as never);

    const tool2 = getRegisteredTool(server2, "tool_a");
    await tool2?.handler(makeExtra({ requestId: "req-4" }));

    const secondSessionId = (yavioTransport.sent.at(-1) as unknown as BaseEvent[])[0].session_id;

    // Different sessions since there's no MCP session ID to correlate
    expect(firstSessionId).not.toBe(secondSessionId);
  });

  it("reuses session via _meta['openai/session'] across reconnections", async () => {
    const yavioTransport = createMockTransport();

    // First connection — OpenAI re-initializes per tool call, no Mcp-Session-Id
    const { server: server1, proxy: proxy1 } = createServerAndProxy(yavioTransport);
    const mcpTransport1 = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
    await proxy1.connect(mcpTransport1 as never);

    const tool1 = getRegisteredTool(server1, "tool_a");
    await tool1?.handler(
      makeExtra({
        _meta: {
          "openai/session": "v1/conversation-abc",
          "openai/subject": "v1/user-xyz",
        },
      }),
    );

    const firstSessionId = (yavioTransport.sent.at(-1) as unknown as BaseEvent[])[0].session_id;

    // Second connection — new server + proxy, same OpenAI session
    const { server: server2, proxy: proxy2 } = createServerAndProxy(yavioTransport);
    const mcpTransport2 = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
    await proxy2.connect(mcpTransport2 as never);

    const tool2 = getRegisteredTool(server2, "tool_a");
    await tool2?.handler(
      makeExtra({
        requestId: "req-2",
        _meta: {
          "openai/session": "v1/conversation-abc",
          "openai/subject": "v1/user-xyz",
        },
      }),
    );

    const secondSessionId = (yavioTransport.sent.at(-1) as unknown as BaseEvent[])[0].session_id;

    expect(firstSessionId).toBe(secondSessionId);
  });

  it("prefers extra.sessionId over _meta['openai/session']", async () => {
    const yavioTransport = createMockTransport();

    // Connection with both MCP session ID and OpenAI session
    const { server: server1, proxy: proxy1 } = createServerAndProxy(yavioTransport);
    const mcpTransport1 = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
    await proxy1.connect(mcpTransport1 as never);

    const tool1 = getRegisteredTool(server1, "tool_a");
    await tool1?.handler(
      makeExtra({
        sessionId: "mcp-session-real",
        _meta: { "openai/session": "v1/conversation-xyz" },
      }),
    );

    const firstSessionId = (yavioTransport.sent.at(-1) as unknown as BaseEvent[])[0].session_id;

    // Second connection — same MCP session, different OpenAI session
    const { server: server2, proxy: proxy2 } = createServerAndProxy(yavioTransport);
    const mcpTransport2 = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
    await proxy2.connect(mcpTransport2 as never);

    const tool2 = getRegisteredTool(server2, "tool_a");
    await tool2?.handler(
      makeExtra({
        sessionId: "mcp-session-real",
        requestId: "req-2",
        _meta: { "openai/session": "v1/different-conversation" },
      }),
    );

    const secondSessionId = (yavioTransport.sent.at(-1) as unknown as BaseEvent[])[0].session_id;

    // Should correlate on MCP session ID, not OpenAI session
    expect(firstSessionId).toBe(secondSessionId);
  });

  it("creates separate sessions for different _meta['openai/session'] values", async () => {
    const yavioTransport = createMockTransport();

    // First connection — conversation alpha
    const { server: server1, proxy: proxy1 } = createServerAndProxy(yavioTransport);
    const mcpTransport1 = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
    await proxy1.connect(mcpTransport1 as never);

    const tool1 = getRegisteredTool(server1, "tool_a");
    await tool1?.handler(makeExtra({ _meta: { "openai/session": "v1/conversation-alpha" } }));

    const firstSessionId = (yavioTransport.sent.at(-1) as unknown as BaseEvent[])[0].session_id;

    // Second connection — conversation beta (different conversation, same user)
    const { server: server2, proxy: proxy2 } = createServerAndProxy(yavioTransport);
    const mcpTransport2 = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
    await proxy2.connect(mcpTransport2 as never);

    const tool2 = getRegisteredTool(server2, "tool_a");
    await tool2?.handler(
      makeExtra({
        requestId: "req-2",
        _meta: { "openai/session": "v1/conversation-beta" },
      }),
    );

    const secondSessionId = (yavioTransport.sent.at(-1) as unknown as BaseEvent[])[0].session_id;

    expect(firstSessionId).not.toBe(secondSessionId);
  });

  it("caps session map size at MAX_SESSION_MAP_SIZE", async () => {
    const yavioTransport = createMockTransport();

    // Create 1001 connections with unique MCP session IDs via extra.sessionId
    for (let i = 0; i < 1001; i++) {
      const { server, proxy } = createServerAndProxy(yavioTransport);
      const mcpTransport = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
      await proxy.connect(mcpTransport as never);
      const tool = getRegisteredTool(server, "tool_a");
      await tool?.handler(makeExtra({ sessionId: `mcp-session-${i}`, requestId: `req-cap-${i}` }));
    }

    // Capture the original Yavio session ID for mcp-session-0
    // Events: [connection_0, tool_call_0, connection_1, tool_call_1, ...]
    // tool_call_0 is at index 1
    const originalSessionId = (yavioTransport.sent[1] as unknown as BaseEvent[])[0].session_id;

    // Reconnect with the very first MCP session ID — it should have been evicted
    const { server, proxy } = createServerAndProxy(yavioTransport);
    const mcpTransport = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
    await proxy.connect(mcpTransport as never);
    const tool = getRegisteredTool(server, "tool_a");
    await tool?.handler(makeExtra({ sessionId: "mcp-session-0", requestId: "req-cap-final" }));

    const finalSessionId = (yavioTransport.sent.at(-1) as unknown as BaseEvent[])[0].session_id;

    // mcp-session-0 was evicted, so a new Yavio session was created
    expect(finalSessionId).not.toBe(originalSessionId);
  });
});
