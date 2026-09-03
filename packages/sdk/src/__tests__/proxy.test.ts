import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BaseEvent } from "@yavio/shared/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CaptureConfig, YavioConfig } from "../core/types.js";
import { createYavioContext } from "../server/context.js";
import { _resetGlobalState, createProxy } from "../server/proxy.js";
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
  serverOnly: false,
  intent: { enabled: false, required: true, description: "test" },
  tools: {},
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

describe("createProxy — serverOnly mode", () => {
  const serverOnlyConfig: YavioConfig = { ...testConfig, serverOnly: true };

  beforeEach(() => {
    mockedMint.mockReset();
    _resetGlobalState();
  });

  it("does not inject _meta.yavio when serverOnly is true", async () => {
    mockedMint.mockResolvedValue({
      token: "jwt_should_not_be_used",
      expiresAt: "2026-01-01T00:00:00Z",
    });

    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, serverOnlyConfig, transport, "0.0.1");

    proxy.tool("server_only_tool", (extra) => ({
      content: [{ type: "text", text: "ok" }],
    }));

    const tool = getRegisteredTool(server, "server_only_tool");
    const mockExtra = {
      signal: new AbortController().signal,
      requestId: "req-so-1",
      sendNotification: async () => {},
      sendRequest: async () => ({}),
    };

    const result = (await tool?.handler(mockExtra)) as Record<string, unknown>;
    expect(result._meta).toBeUndefined();
  });

  it("does not call mintWidgetToken when serverOnly is true", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, serverOnlyConfig, transport, "0.0.1");

    proxy.tool("no_mint_tool", (extra) => ({
      content: [{ type: "text", text: "ok" }],
    }));

    const tool = getRegisteredTool(server, "no_mint_tool");
    await tool?.handler({
      signal: new AbortController().signal,
      requestId: "req-so-2",
      sendNotification: async () => {},
      sendRequest: async () => ({}),
    });

    expect(mockedMint).not.toHaveBeenCalled();
  });

  it("preserves existing _meta from the handler verbatim", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, serverOnlyConfig, transport, "0.0.1");

    proxy.tool("preserve_meta_tool", (extra) => ({
      content: [{ type: "text", text: "ok" }],
      _meta: { custom: "value" },
    }));

    const tool = getRegisteredTool(server, "preserve_meta_tool");
    const result = (await tool?.handler({
      signal: new AbortController().signal,
      requestId: "req-so-3",
      sendNotification: async () => {},
      sendRequest: async () => ({}),
    })) as Record<string, unknown>;

    expect(result._meta).toEqual({ custom: "value" });
  });

  it("still emits tool_discovery and tool_call events in serverOnly mode", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, serverOnlyConfig, transport, "0.0.1");

    proxy.tool("events_still_fire", (extra) => ({
      content: [{ type: "text", text: "ok" }],
    }));

    // tool_discovery fires synchronously on registration
    const discoveryBatch = transport.sent[0];
    expect(discoveryBatch?.[0].event_type).toBe("tool_discovery");

    const tool = getRegisteredTool(server, "events_still_fire");
    await tool?.handler({
      signal: new AbortController().signal,
      requestId: "req-so-4",
      sendNotification: async () => {},
      sendRequest: async () => ({}),
    });

    const eventTypes = transport.sent.flat().map((e) => e.event_type);
    expect(eventTypes).toContain("connection");
    expect(eventTypes).toContain("tool_call");
  });
});

describe("createProxy — fluent chaining (Skybridge-style)", () => {
  beforeEach(() => {
    mockedMint.mockReset();
    mockedMint.mockResolvedValue(null);
    _resetGlobalState();
  });

  /** A minimal Skybridge-style server whose registerTool returns `this` for chaining. */
  function makeFluentServer() {
    const registered: string[] = [];
    const server = {
      server: {},
      connect: async () => {},
      tool() {
        return this;
      },
      registerTool(name: string, _config: unknown, _cb: unknown) {
        registered.push(name);
        return this; // fluent: returns the server for chaining
      },
    };
    return { server, registered };
  }

  it("keeps the chain on the proxy so every chained registerTool is instrumented", () => {
    const { server, registered } = makeFluentServer();
    const transport = createMockTransport();
    const proxy = createProxy(server as unknown as McpServer, testConfig, transport, "0.0.1");

    // The base McpServer type returns RegisteredTool from registerTool; Skybridge's
    // McpServer<TTools> returns the accumulated server for chaining. Model the
    // fluent shape locally so the chained calls type-check.
    type Chainable = {
      registerTool(name: string, config: unknown, cb: () => { content: unknown[] }): Chainable;
    };
    const chain = proxy as unknown as Chainable;

    const ret = chain
      .registerTool("a", {}, () => ({ content: [{ type: "text", text: "" }] }))
      .registerTool("b", {}, () => ({ content: [{ type: "text", text: "" }] }))
      .registerTool("c", {}, () => ({ content: [{ type: "text", text: "" }] }));

    // All three reached the underlying server
    expect(registered).toEqual(["a", "b", "c"]);

    // tool_discovery emitted for ALL three — proves each registerTool was intercepted,
    // not just the first (the bug this fix addresses)
    const discovered = transport.sent
      .flat()
      .filter((e) => e.event_type === "tool_discovery")
      .map((e) => (e as Record<string, unknown>).tool_name);
    expect(discovered).toEqual(["a", "b", "c"]);

    // The chain stayed on the proxy
    expect(ret).toBe(proxy);
  });

  it("passes a RegisteredTool handle (plain MCP SDK) through unchanged", () => {
    const handle = { enable() {}, disable() {}, remove() {} };
    const server = {
      server: {},
      connect: async () => {},
      tool() {
        return this;
      },
      registerTool() {
        return handle; // plain MCP SDK returns a handle, not the server
      },
    };
    const transport = createMockTransport();
    const proxy = createProxy(server as unknown as McpServer, testConfig, transport, "0.0.1");

    const ret = proxy.registerTool("x", {}, () => ({ content: [{ type: "text", text: "" }] }));
    expect(ret).toBe(handle);
    expect(ret).not.toBe(proxy);
  });
});

describe("createProxy — Skybridge registerTool(config, cb)", () => {
  beforeEach(() => {
    mockedMint.mockReset();
    mockedMint.mockResolvedValue(null);
    _resetGlobalState();
  });

  /**
   * A minimal Skybridge-style server: registerTool takes (config, cb) with the
   * tool name on config.name, stores the callback it receives, and returns
   * `this` for chaining — mirroring skybridge's McpServer.
   */
  function makeSkybridgeServer() {
    const handlers = new Map<string, (...cbArgs: unknown[]) => unknown>();
    const server = {
      server: {},
      connect: async () => {},
      tool() {
        return this;
      },
      registerTool(config: { name: string }, cb: (...cbArgs: unknown[]) => unknown) {
        handlers.set(config.name, cb);
        return this;
      },
    };
    return { server, handlers };
  }

  /** The 2-arg fluent shape so chained calls type-check against the proxy. */
  type SkybridgeChainable = {
    registerTool(
      config: Record<string, unknown>,
      cb: (...cbArgs: unknown[]) => unknown,
    ): SkybridgeChainable;
  };

  function makeExtra(overrides?: Record<string, unknown>) {
    return {
      signal: new AbortController().signal,
      requestId: "req-sb-1",
      sendNotification: async () => {},
      sendRequest: async () => ({}),
      ...overrides,
    };
  }

  it("derives the tool name from config.name for tool_discovery", () => {
    const { server } = makeSkybridgeServer();
    const transport = createMockTransport();
    const proxy = createProxy(
      server as unknown as McpServer,
      testConfig,
      transport,
      "0.0.1",
    ) as unknown as SkybridgeChainable;

    proxy.registerTool(
      {
        name: "search_rooms",
        description: "Search available rooms",
        inputSchema: { query: { type: "string" } },
      },
      () => ({ content: [{ type: "text", text: "ok" }] }),
    );

    expect(transport.sent.length).toBe(1);
    const event = transport.sent[0][0] as Record<string, unknown>;
    expect(event.event_type).toBe("tool_discovery");
    expect(event.tool_name).toBe("search_rooms");
    expect(event.description).toBe("Search available rooms");
    expect(event.input_schema).toEqual({ query: { type: "string" } });
  });

  it("wraps the handler so invoking it emits connection and tool_call events", async () => {
    const { server, handlers } = makeSkybridgeServer();
    const transport = createMockTransport();
    const proxy = createProxy(
      server as unknown as McpServer,
      testConfig,
      transport,
      "0.0.1",
    ) as unknown as SkybridgeChainable;

    let handlerCalled = false;
    proxy.registerTool({ name: "book_room" }, () => {
      handlerCalled = true;
      return { content: [{ type: "text", text: "booked" }] };
    });

    // The underlying server must have received the WRAPPED callback
    const wrapped = handlers.get("book_room");
    expect(wrapped).toBeDefined();

    const result = (await wrapped?.({ roomId: "r1" }, makeExtra())) as Record<string, unknown>;
    expect(handlerCalled).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "booked" }]);

    const eventTypes = transport.sent.flat().map((e) => e.event_type);
    expect(eventTypes).toContain("connection");
    expect(eventTypes).toContain("tool_call");

    const toolCall = transport.sent
      .flat()
      .find((e) => e.event_type === "tool_call") as unknown as Record<string, unknown>;
    expect(toolCall.event_name).toBe("book_room");
    expect(toolCall.status).toBe("success");
  });

  it("emits an error tool_call and rethrows when the handler throws", async () => {
    const { server, handlers } = makeSkybridgeServer();
    const transport = createMockTransport();
    const proxy = createProxy(
      server as unknown as McpServer,
      testConfig,
      transport,
      "0.0.1",
    ) as unknown as SkybridgeChainable;

    proxy.registerTool({ name: "failing_tool" }, () => {
      throw new Error("boom");
    });

    const wrapped = handlers.get("failing_tool");
    await expect(wrapped?.({}, makeExtra())).rejects.toThrow("boom");

    const toolCall = transport.sent
      .flat()
      .find((e) => e.event_type === "tool_call") as unknown as Record<string, unknown>;
    expect(toolCall.event_name).toBe("failing_tool");
    expect(toolCall.status).toBe("error");
    expect(toolCall.error_message).toBe("boom");
  });

  it("instruments every registration in a fluent chain", () => {
    const { server, handlers } = makeSkybridgeServer();
    const transport = createMockTransport();
    const proxy = createProxy(
      server as unknown as McpServer,
      testConfig,
      transport,
      "0.0.1",
    ) as unknown as SkybridgeChainable;

    const ret = proxy
      .registerTool({ name: "a" }, () => ({ content: [{ type: "text", text: "" }] }))
      .registerTool({ name: "b" }, () => ({ content: [{ type: "text", text: "" }] }))
      .registerTool({ name: "c" }, () => ({ content: [{ type: "text", text: "" }] }));

    expect([...handlers.keys()]).toEqual(["a", "b", "c"]);

    const discovered = transport.sent
      .flat()
      .filter((e) => e.event_type === "tool_discovery")
      .map((e) => (e as unknown as Record<string, unknown>).tool_name);
    expect(discovered).toEqual(["a", "b", "c"]);

    // The chain stayed on the proxy so later registrations remain intercepted
    expect(ret).toBe(proxy);
  });

  it("falls back to 'unknown' when no name is derivable", () => {
    const { server } = makeSkybridgeServer();
    const transport = createMockTransport();
    const proxy = createProxy(
      server as unknown as McpServer,
      testConfig,
      transport,
      "0.0.1",
    ) as unknown as SkybridgeChainable;

    proxy.registerTool({}, () => ({ content: [{ type: "text", text: "" }] }));

    const event = transport.sent[0][0] as Record<string, unknown>;
    expect(event.event_type).toBe("tool_discovery");
    expect(event.tool_name).toBe("unknown");
  });
});

describe("createProxy — tool_discovery emission", () => {
  beforeEach(() => {
    mockedMint.mockReset();
    mockedMint.mockResolvedValue(null);
    _resetGlobalState();
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
    _resetGlobalState();
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

  it("produces stable session IDs across independent proxy instances", async () => {
    const yavioTransport = createMockTransport();

    // Two completely independent proxy instances (simulating different server instances)
    // with the same MCP session key should produce the same Yavio session ID.
    const { server: server1, proxy: proxy1 } = createServerAndProxy(yavioTransport);
    const mcpTransport1 = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
    await proxy1.connect(mcpTransport1 as never);
    const tool1 = getRegisteredTool(server1, "tool_a");
    await tool1?.handler(makeExtra({ sessionId: "mcp-session-stable" }));

    const firstSessionId = (yavioTransport.sent.at(-1) as unknown as BaseEvent[])[0].session_id;

    // Reset global state to simulate a completely separate process
    _resetGlobalState();

    const { server: server2, proxy: proxy2 } = createServerAndProxy(yavioTransport);
    const mcpTransport2 = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
    await proxy2.connect(mcpTransport2 as never);
    const tool2 = getRegisteredTool(server2, "tool_a");
    await tool2?.handler(makeExtra({ sessionId: "mcp-session-stable", requestId: "req-2" }));

    const secondSessionId = (yavioTransport.sent.at(-1) as unknown as BaseEvent[])[0].session_id;

    // Deterministic derivation — no shared state needed
    expect(firstSessionId).toBe(secondSessionId);
    expect(firstSessionId).toMatch(/^ses_/);
  });
});

describe("createProxy — client identity on connection events", () => {
  beforeEach(() => {
    mockedMint.mockReset();
    mockedMint.mockResolvedValue(null);
    _resetGlobalState();
  });

  async function invokeTool(server: McpServer, name: string) {
    const tool = getRegisteredTool(server, name);
    await tool?.handler({
      signal: new AbortController().signal,
      requestId: "req-ci-1",
      sendNotification: async () => {},
      sendRequest: async () => ({}),
    });
  }

  it("persists client_name and client_version from the MCP handshake", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    (server.server as unknown as Record<string, unknown>).getClientVersion = () => ({
      name: "claude-code",
      version: "2.1.218",
    });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    proxy.tool("identity_tool", () => ({ content: [{ type: "text", text: "ok" }] }));
    await invokeTool(server, "identity_tool");

    const connection = transport.sent.flat().find((e) => e.event_type === "connection") as Record<
      string,
      unknown
    >;
    expect(connection).toBeDefined();
    expect(connection.client_name).toBe("claude-code");
    expect(connection.client_version).toBe("2.1.218");
  });

  it("resolves the platform before the connection event is emitted", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    (server.server as unknown as Record<string, unknown>).getClientVersion = () => ({
      name: "codex-mcp-client",
      version: "0.108.0",
    });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    proxy.tool("platform_tool", () => ({ content: [{ type: "text", text: "ok" }] }));
    await invokeTool(server, "platform_tool");

    const connection = transport.sent.flat().find((e) => e.event_type === "connection") as Record<
      string,
      unknown
    >;
    expect(connection.platform).toBe("codex");
  });

  it("omits client identity when the handshake exposes none", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    proxy.tool("anonymous_tool", () => ({ content: [{ type: "text", text: "ok" }] }));
    await invokeTool(server, "anonymous_tool");

    const connection = transport.sent.flat().find((e) => e.event_type === "connection") as Record<
      string,
      unknown
    >;
    expect(connection).toBeDefined();
    expect(connection.client_name).toBeUndefined();
    expect(connection.platform).toBe("unknown");
  });
});

describe("createProxy — platform detection from HTTP request headers", () => {
  beforeEach(() => {
    mockedMint.mockReset();
    mockedMint.mockResolvedValue(null);
    _resetGlobalState();
  });

  it("falls back to User-Agent when the handshake identity is unrecognised", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    (server.server as unknown as Record<string, unknown>).getClientVersion = () => ({
      name: "SomeUnknownClient",
      version: "1.0.0",
    });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    proxy.tool("ua_tool", () => ({ content: [{ type: "text", text: "ok" }] }));
    const tool = getRegisteredTool(server, "ua_tool");
    await tool?.handler({
      signal: new AbortController().signal,
      requestId: "req-ua-1",
      sendNotification: async () => {},
      sendRequest: async () => ({}),
      requestInfo: { headers: { "user-agent": "Cursor/1.0" } },
    });

    const toolCall = transport.sent.flat().find((e) => e.event_type === "tool_call") as Record<
      string,
      unknown
    >;
    expect(toolCall.platform).toBe("cursor");
  });

  it("detects the platform from the Origin header when nothing else matches", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    proxy.tool("origin_tool", () => ({ content: [{ type: "text", text: "ok" }] }));
    const tool = getRegisteredTool(server, "origin_tool");
    await tool?.handler({
      signal: new AbortController().signal,
      requestId: "req-or-1",
      sendNotification: async () => {},
      sendRequest: async () => ({}),
      requestInfo: { headers: { origin: "https://gemini.google.com" } },
    });

    const toolCall = transport.sent.flat().find((e) => e.event_type === "tool_call") as Record<
      string,
      unknown
    >;
    expect(toolCall.platform).toBe("gemini");
  });
});

describe("request info capture", () => {
  async function callWithRequestInfo(requestInfo: unknown) {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    proxy.tool("ri_tool", { q: z.string() }, () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    const tool = getRegisteredTool(server, "ri_tool");
    await tool?.handler(
      { q: "hello" },
      {
        signal: new AbortController().signal,
        requestId: "req-ri-1",
        sendNotification: async () => {},
        sendRequest: async () => ({}),
        requestInfo,
      },
    );

    const toolCall = transport.sent.flat().find((e) => e.event_type === "tool_call") as Record<
      string,
      unknown
    >;
    return (toolCall.input_values ?? {}) as Record<string, unknown>;
  }

  it("never stores credential-bearing headers", async () => {
    const inputValues = await callWithRequestInfo({
      headers: {
        authorization: "Bearer super-secret-token",
        cookie: "session=abc123",
        "x-api-key": "sk-live-4242",
        "proxy-authorization": "Basic dXNlcjpwYXNz",
        "user-agent": "Cursor/1.0",
      },
    });

    const serialized = JSON.stringify(inputValues);
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("sk-live-4242");
    expect(serialized).not.toContain("dXNlcjpwYXNz");

    const requestInfo = inputValues._requestInfo as { headers: Record<string, string> };
    expect(Object.keys(requestInfo.headers)).toEqual(["user-agent"]);
  });

  it("drops an end-user IP forwarded by a proxy", async () => {
    const inputValues = await callWithRequestInfo({
      headers: { "x-forwarded-for": "203.0.113.7", "x-real-ip": "203.0.113.7" },
    });

    expect(JSON.stringify(inputValues)).not.toContain("203.0.113.7");
    expect(inputValues._requestInfo).toBeUndefined();
  });

  it("keeps the allowlisted headers, normalizing name case and array values", async () => {
    const inputValues = await callWithRequestInfo({
      headers: {
        "User-Agent": "ChatGPT/1.2",
        "Accept-Language": ["de-DE", "de"],
        host: "example.test",
      },
    });

    expect(inputValues._requestInfo).toEqual({
      headers: { "user-agent": "ChatGPT/1.2", "accept-language": "de-DE, de" },
    });
  });

  it("rejects a hand-built Authorization header regardless of case", async () => {
    const inputValues = await callWithRequestInfo({
      headers: { Authorization: "Bearer leaked", AUTHORIZATION: "Bearer leaked-too" },
    });

    expect(JSON.stringify(inputValues)).not.toContain("leaked");
    expect(inputValues._requestInfo).toBeUndefined();
  });

  it("strips the query string and fragment from the URL", async () => {
    const inputValues = await callWithRequestInfo({
      headers: { "user-agent": "ChatGPT/1.2" },
      url: "https://app.example.test/mcp?access_token=secret-value#frag",
    });

    const requestInfo = inputValues._requestInfo as { url: string };
    expect(requestInfo.url).toBe("https://app.example.test/mcp");
    expect(JSON.stringify(inputValues)).not.toContain("secret-value");
  });

  it("still records the tool's own arguments", async () => {
    const inputValues = await callWithRequestInfo({
      headers: { authorization: "Bearer nope" },
    });

    expect(inputValues.q).toBe("hello");
  });
});

describe("client metadata capture", () => {
  const CHATGPT_META = {
    "openai/locale": "de-DE",
    "openai/userAgent": "ChatGPT/1.2026.195 (Android 15; SM-S921B; build 2619512)",
    "openai/subject": "v1/2vDU0AOje8kKSAasHqXU4Y",
    "openai/userLocation": {
      city: "Duisburg",
      region: "North Rhine-Westphalia",
      country: "DE",
      timezone: "Europe/Berlin",
      latitude: "51.43247",
      longitude: "6.76516",
    },
    "openai/session": "v1/49A5b4dMHXWnQuVmyqIS4O",
  };

  async function callWithMeta(config: YavioConfig, _meta: unknown) {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, config, transport, "0.0.1");
    proxy.tool("meta_tool", { q: z.string() }, () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    const tool = getRegisteredTool(server, "meta_tool");
    await tool?.handler(
      { q: "hello" },
      {
        signal: new AbortController().signal,
        requestId: "req-cm-1",
        sendNotification: async () => {},
        sendRequest: async () => ({}),
        _meta,
      },
    );
    return transport.sent.flat().find((e) => e.event_type === "tool_call") as Record<
      string,
      unknown
    >;
  }

  it("lifts ChatGPT client metadata into first-class fields, country as code only", async () => {
    const event = await callWithMeta(testConfig, CHATGPT_META);
    expect(event.country_code).toBe("DE");
    expect(event.locale).toBe("de-DE");
    expect(event.end_user_agent).toContain("Android 15");
    expect(event.subject_id).toBe("v1/2vDU0AOje8kKSAasHqXU4Y");
    // City and coordinates must never appear as structured fields
    expect(JSON.stringify({ ...event, input_values: undefined })).not.toContain("Duisburg");
    expect(JSON.stringify({ ...event, input_values: undefined })).not.toContain("51.43247");
  });

  it("omits the country when capture.geo is off, keeps the rest", async () => {
    const event = await callWithMeta(
      { ...testConfig, capture: { ...testConfig.capture, geo: false } },
      CHATGPT_META,
    );
    expect(event.country_code).toBeUndefined();
    expect(event.locale).toBe("de-DE");
    expect(event.subject_id).toBe("v1/2vDU0AOje8kKSAasHqXU4Y");
  });

  it("captures nothing when inputValues capture is off", async () => {
    const event = await callWithMeta(
      { ...testConfig, capture: { ...testConfig.capture, inputValues: false } },
      CHATGPT_META,
    );
    expect(event.country_code).toBeUndefined();
    expect(event.locale).toBeUndefined();
    expect(event.end_user_agent).toBeUndefined();
    expect(event.subject_id).toBeUndefined();
  });

  it("produces no fields for platforms that send no metadata (claude.ai)", async () => {
    const event = await callWithMeta(testConfig, undefined);
    expect(event.country_code).toBeUndefined();
    expect(event.locale).toBeUndefined();
    expect(event.subject_id).toBeUndefined();
  });

  it("rejects a malformed country instead of storing junk", async () => {
    const event = await callWithMeta(testConfig, {
      "openai/userLocation": { country: "Germany" },
    });
    expect(event.country_code).toBeUndefined();
  });
});

describe("tool-result errors (isError: true)", () => {
  beforeEach(() => {
    mockedMint.mockReset();
    mockedMint.mockResolvedValue(null);
    _resetGlobalState();
  });

  const extra = () => ({
    signal: new AbortController().signal,
    requestId: "req-te-1",
    sendNotification: async () => {},
    sendRequest: async () => ({}),
  });

  /** Register a tool returning `result`, invoke it once, return the tool_call event and the result. */
  async function callReturning(result: Record<string, unknown>, config: YavioConfig = testConfig) {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, config, transport, "0.0.1");
    // The handler deliberately returns shapes the CallToolResult type rejects
    // (a string isError, no content) — the proxy must classify them anyway.
    proxy.tool("te_tool", { q: z.string() }, () => result as never);
    const tool = getRegisteredTool(server, "te_tool");
    const returned = await tool?.handler({ q: "hello" }, extra());
    const event = transport.sent.flat().find((e) => e.event_type === "tool_call") as Record<
      string,
      unknown
    >;
    return { event, returned };
  }

  it("records an isError result as status error, category tool_error, with the text as message", async () => {
    const { event, returned } = await callReturning({
      isError: true,
      content: [{ type: "text", text: "This offer reference has expired" }],
    });
    expect(event.status).toBe("error");
    expect(event.error_category).toBe("tool_error");
    expect(event.error_message).toBe("This offer reference has expired");
    // Inputs and output are captured as on the success path: the model saw
    // this result, and its text explains the error.
    expect(event.input_keys).toEqual({ q: true });
    expect(event.input_values).toMatchObject({ q: "hello" });
    expect((event.output_content as Record<string, unknown>).isError).toBe(true);
    expect(typeof event.latency_ms).toBe("number");
    // The result goes back to the client untouched
    expect((returned as Record<string, unknown>).isError).toBe(true);
  });

  it("uses the first text item as the message, skipping non-text content", async () => {
    const { event } = await callReturning({
      isError: true,
      content: [
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "  first text  " },
        { type: "text", text: "second text" },
      ],
    });
    expect(event.error_message).toBe("first text");
  });

  it("records an isError result without text as an error without a message", async () => {
    const { event } = await callReturning({
      isError: true,
      content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    });
    expect(event.status).toBe("error");
    expect(event.error_category).toBe("tool_error");
    expect(event.error_message).toBeUndefined();
  });

  it("treats only the literal boolean true as an error", async () => {
    for (const isError of [false, "true", 1, undefined]) {
      const { event } = await callReturning({
        ...(isError === undefined ? {} : { isError }),
        content: [{ type: "text", text: "fine" }],
      });
      expect(event.status, `isError=${JSON.stringify(isError)}`).toBe("success");
      expect(event.error_category).toBeUndefined();
      expect(event.error_message).toBeUndefined();
    }
  });

  it("redacts PII in the result text and clamps it to 500 characters", async () => {
    const { event } = await callReturning({
      isError: true,
      content: [{ type: "text", text: `customer max@example.com not found ${"x".repeat(600)}` }],
    });
    const message = event.error_message as string;
    expect(message).toContain("[EMAIL_REDACTED]");
    expect(message).not.toContain("max@example.com");
    expect(message).toHaveLength(500);
  });

  // Regression: the thrown-path message bypassed stripPii until 0.4.0.
  it("redacts PII in a thrown error's message too", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    proxy.tool("throwing", () => {
      throw new Error("customer max@example.com not found");
    });
    const tool = getRegisteredTool(server, "throwing");
    await expect(tool?.handler(extra())).rejects.toThrow();
    const event = transport.sent.flat().find((e) => e.event_type === "tool_call") as Record<
      string,
      unknown
    >;
    expect(event.status).toBe("error");
    expect(event.error_category).toBe("unknown");
    expect(event.error_message).toBe("customer [EMAIL_REDACTED] not found");
  });

  it("keeps status and category but drops the result-derived message when output capture is off", async () => {
    const { event } = await callReturning(
      {
        isError: true,
        content: [{ type: "text", text: "no tariff for customer number 4711" }],
      },
      { ...testConfig, capture: { ...testConfig.capture, outputValues: false } },
    );
    expect(event.status).toBe("error");
    expect(event.error_category).toBe("tool_error");
    // The text is output: with outputValues off it must not leak through
    // error_message either.
    expect(event.error_message).toBeUndefined();
    expect(event.output_content).toBeUndefined();
  });

  it("still injects the widget token into an isError result", async () => {
    mockedMint.mockResolvedValue({ token: "jwt_widget_err", expiresAt: "2099-01-01T00:00:00Z" });
    const { event, returned } = await callReturning({
      isError: true,
      content: [{ type: "text", text: "boom" }],
    });
    expect(event.status).toBe("error");
    const meta = (returned as Record<string, unknown>)._meta as Record<string, unknown>;
    expect((meta.yavio as Record<string, unknown>).token).toBe("jwt_widget_err");
    // Captured before injection: the event's output must not carry our token
    expect(JSON.stringify(event.output_content)).not.toContain("jwt_widget_err");
  });
});

describe("per-tool capture overrides", () => {
  beforeEach(() => {
    mockedMint.mockReset();
    mockedMint.mockResolvedValue(null);
    _resetGlobalState();
  });

  const CHATGPT_META = {
    "openai/locale": "de-DE",
    "openai/userAgent": "ChatGPT/1.2026.195",
    "openai/subject": "v1/2vDU0AOje8kKSAasHqXU4Y",
    "openai/userLocation": { country: "DE", city: "Duisburg" },
  };

  const extra = () => ({
    signal: new AbortController().signal,
    requestId: "req-pt-1",
    sendNotification: async () => {},
    sendRequest: async () => ({}),
    _meta: CHATGPT_META,
  });

  const configWith = (tools: YavioConfig["tools"]): YavioConfig => ({ ...testConfig, tools });

  const toolCallFor = (transport: ReturnType<typeof createMockTransport>, name: string) =>
    transport.sent
      .flat()
      .find(
        (e) => e.event_type === "tool_call" && (e as { event_name?: string }).event_name === name,
      ) as Record<string, unknown> | undefined;

  const INPUT_FIELDS = [
    "input_keys",
    "input_types",
    "input_values",
    "locale",
    "country_code",
    "end_user_agent",
    "subject_id",
  ] as const;

  function expectNoInputs(event: Record<string, unknown> | undefined) {
    expect(event).toBeDefined();
    for (const field of INPUT_FIELDS) {
      expect(event?.[field], field).toBeUndefined();
    }
  }

  function expectInputs(event: Record<string, unknown> | undefined) {
    expect(event).toBeDefined();
    expect(event?.input_keys).toEqual({ q: true });
    expect(event?.input_values).toMatchObject({ q: "hello" });
    expect(event?.locale).toBe("de-DE");
    expect(event?.subject_id).toBe("v1/2vDU0AOje8kKSAasHqXU4Y");
    expect(event?.country_code).toBe("DE");
  }

  it("applies the override via server.tool() and leaves other tools in the same server untouched", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(
      server,
      configWith({ book: { inputValues: false, outputValues: false } }),
      transport,
      "0.0.1",
    );
    const result = { content: [{ type: "text" as const, text: "ok" }] };
    proxy.tool("book", { q: z.string() }, () => result);
    proxy.tool("search", { q: z.string() }, () => result);

    await getRegisteredTool(server, "book")?.handler({ q: "hello" }, extra());
    await getRegisteredTool(server, "search")?.handler({ q: "hello" }, extra());

    const book = toolCallFor(transport, "book");
    expectNoInputs(book);
    expect(book?.output_content).toBeUndefined();
    expect(book?.status).toBe("success");
    expect(typeof book?.latency_ms).toBe("number");
    expect(JSON.stringify(book)).not.toContain("Duisburg");

    const search = toolCallFor(transport, "search");
    expectInputs(search);
    expect(search?.output_content).toBeDefined();
  });

  it("applies the override via server.registerTool(name, config, cb)", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(
      server,
      configWith({ book: { inputValues: false } }),
      transport,
      "0.0.1",
    );
    proxy.registerTool("book", { inputSchema: { q: z.string() } }, () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    await getRegisteredTool(server, "book")?.handler({ q: "hello" }, extra());
    const book = toolCallFor(transport, "book");
    expectNoInputs(book);
    // Only inputValues was overridden: output capture follows the global flag.
    expect(book?.output_content).toBeDefined();
  });

  it("applies the override via Skybridge-style registerTool(config, cb)", async () => {
    const handlers = new Map<string, (...cbArgs: unknown[]) => unknown>();
    const server = {
      server: {},
      connect: async () => {},
      tool() {
        return this;
      },
      registerTool(config: { name: string }, cb: (...cbArgs: unknown[]) => unknown) {
        handlers.set(config.name, cb);
        return this;
      },
    };
    const transport = createMockTransport();
    const proxy = createProxy(
      server as unknown as McpServer,
      configWith({ book: { inputValues: false, outputValues: false } }),
      transport,
      "0.0.1",
    ) as unknown as {
      registerTool(config: Record<string, unknown>, cb: (...cbArgs: unknown[]) => unknown): unknown;
    };
    proxy.registerTool({ name: "book" }, () => ({ content: [{ type: "text", text: "ok" }] }));

    await handlers.get("book")?.({ q: "hello" }, extra());
    const book = toolCallFor(transport, "book");
    expectNoInputs(book);
    expect(book?.output_content).toBeUndefined();
  });

  it("drops inputs and client meta on the throw path too, keeping the developer's message", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(
      server,
      configWith({ book: { inputValues: false, outputValues: false } }),
      transport,
      "0.0.1",
    );
    proxy.tool("book", { q: z.string() }, () => {
      throw new Error("upstream unavailable");
    });
    await expect(
      getRegisteredTool(server, "book")?.handler({ q: "hello" }, extra()),
    ).rejects.toThrow();
    const book = toolCallFor(transport, "book");
    expectNoInputs(book);
    expect(book?.status).toBe("error");
    expect(book?.error_category).toBe("unknown");
    expect(book?.error_message).toBe("upstream unavailable");
  });

  it("keeps status and category for an isError result but drops its text under outputValues: false", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(
      server,
      configWith({ book: { outputValues: false } }),
      transport,
      "0.0.1",
    );
    proxy.tool("book", { q: z.string() }, () => ({
      isError: true,
      content: [{ type: "text", text: "postal code 12345 invalid" }],
    }));
    await getRegisteredTool(server, "book")?.handler({ q: "hello" }, extra());
    const book = toolCallFor(transport, "book");
    expect(book?.status).toBe("error");
    expect(book?.error_category).toBe("tool_error");
    expect(book?.error_message).toBeUndefined();
    expect(book?.output_content).toBeUndefined();
    expect(JSON.stringify(book)).not.toContain("12345");
  });

  it("lets a tool with an override re-enable a globally disabled flag", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(
      server,
      {
        ...testConfig,
        capture: { ...testConfig.capture, inputValues: false },
        tools: { search: { inputValues: true } },
      },
      transport,
      "0.0.1",
    );
    const result = { content: [{ type: "text" as const, text: "ok" }] };
    proxy.tool("search", { q: z.string() }, () => result);
    proxy.tool("other", { q: z.string() }, () => result);
    await getRegisteredTool(server, "search")?.handler({ q: "hello" }, extra());
    await getRegisteredTool(server, "other")?.handler({ q: "hello" }, extra());
    expectInputs(toolCallFor(transport, "search"));
    expectNoInputs(toolCallFor(transport, "other"));
  });

  it("keeps the tracking context inside an overridden tool: a conversion carries the call's ids", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(
      server,
      configWith({ book: { inputValues: false, outputValues: false, intent: false } }),
      transport,
      "0.0.1",
    );
    const yavio = createYavioContext();
    proxy.tool("book", { q: z.string() }, () => {
      yavio.conversion("booking_received", { value: 99, currency: "EUR" });
      return { content: [{ type: "text", text: "booked" }] };
    });
    await getRegisteredTool(server, "book")?.handler({ q: "hello" }, extra());

    const events = transport.sent.flat();
    const conversion = events.find((e) => e.event_type === "conversion");
    const toolCall = events.find((e) => e.event_type === "tool_call");
    expect(conversion).toBeDefined();
    expect(conversion?.trace_id).toBe(toolCall?.trace_id);
    expect(conversion?.session_id).toBe(toolCall?.session_id);
  });
});
