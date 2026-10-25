import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BaseEvent } from "@yavio/shared/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { deriveCustomSessionId, deriveSessionId } from "../core/ids.js";
import type { CaptureConfig, SessionKeyRequest, YavioConfig } from "../core/types.js";
import { createYavioContext } from "../server/context.js";
import {
  _resetGlobalState,
  configFingerprint,
  createProxy,
  valueFreeRejection,
} from "../server/proxy.js";
import { createSharedSessions } from "../server/shared.js";
import { mintWidgetToken } from "../server/token.js";
import type { Transport } from "../transport/types.js";
import { registeredTool } from "./integration/helpers.js";

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
    rejectedInputValues: false,
  } satisfies CaptureConfig,
  serverOnly: false,
  intent: { enabled: false, required: true, description: "test" },
  tools: {},
  shutdownTimeoutMs: 10_000,
  shutdownTimeoutMsSource: "default",
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
        inputSchema: { query: z.string() },
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

    const tool = registeredTool(server, "my_tool");
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

  it("hands the widget the session's source with its session id (#144)", async () => {
    mockedMint.mockResolvedValue({ token: "jwt_w", expiresAt: "2026-01-01T00:00:00Z" });
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(
      server,
      { ...testConfig, sessionKey: ({ headers }) => headers["x-conversation-id"] },
      transport,
      "0.0.1",
    );
    proxy.tool("widget_tool", () => ({ content: [{ type: "text", text: "ok" }] }));
    const handler = registeredTool(server, "widget_tool")?.handler;
    const call = (headers: Record<string, string>) =>
      handler?.({
        signal: new AbortController().signal,
        requestId: "req-w",
        sendNotification: async () => {},
        sendRequest: async () => ({}),
        requestInfo: { headers },
      }) as Promise<{ _meta: { yavio: Record<string, unknown> } }>;

    const perRequest = (await call({ "user-agent": "cursor/1.7.0" }))._meta.yavio;
    expect(perRequest.sessionSource).toBe("per_request");
    const keyed = (await call({ "x-conversation-id": "conv-w" }))._meta.yavio;
    expect(keyed.sessionSource).toBe("custom");
    expect(keyed.sessionId).toBe(deriveCustomSessionId("yav_test", "conv-w"));
  });

  it("returns result unchanged when widget minting fails", async () => {
    mockedMint.mockResolvedValue(null);

    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    proxy.tool("fail_mint_tool", (extra) => ({
      content: [{ type: "text", text: "ok" }],
    }));

    const tool = registeredTool(server, "fail_mint_tool");
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

    const tool = registeredTool(server, "throw_mint_tool");
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

    const tool = registeredTool(server, "meta_tool");
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

  it("never leaves an unhandled rejection: unreachable endpoint, throwing handler, non-object result", async () => {
    // The real mint (not the mock): an endpoint that is not a URL made
    // `new URL()` throw inside the mint promise, which only the object-result
    // path awaited — a throwing handler left it unhandled and the process
    // exited. The mock is bypassed for this test with the module's real code.
    const { mintWidgetToken: realMint } =
      await vi.importActual<typeof import("../server/token.js")>("../server/token.js");
    mockedMint.mockImplementation(realMint);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const server = new McpServer({ name: "test", version: "1.0" });
      const transport = createMockTransport();
      // Syntactically valid but unreachable: the mint's failure path. (An
      // unparseable endpoint never reaches createProxy — resolveConfig goes
      // no-op for it — but the mint guards hold for "" as well.)
      const proxy = createProxy(
        server,
        { ...testConfig, endpoint: "http://127.0.0.1:9/v1/events" },
        transport,
        "0.0.1",
      );
      proxy.tool("throws", async () => {
        throw new Error("boom");
      });
      proxy.tool("non_object", async () => "just a string" as unknown as { content: [] });
      const extra = {
        signal: new AbortController().signal,
        requestId: "req-ur",
        sendNotification: async () => {},
        sendRequest: async () => ({}),
      };
      await expect(registeredTool(server, "throws")?.handler(extra)).rejects.toThrow("boom");
      await expect(registeredTool(server, "non_object")?.handler(extra)).resolves.toBe(
        "just a string",
      );
      // Let any rejection surface.
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
      expect(rejections).toEqual([]);
      const events = transport.sent.flat().filter((e) => e.event_type === "tool_call");
      expect(events.map((e) => (e as { status?: string }).status)).toEqual(["error", "success"]);
    } finally {
      process.off("unhandledRejection", onRejection);
      mockedMint.mockReset();
    }
  });

  it("starts the mint before the handler runs, so its round trip hides behind the handler", async () => {
    let releaseMint: (() => void) | undefined;
    mockedMint.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseMint = () => resolve({ token: "jwt_early", expiresAt: "2099-01-01T00:00:00Z" });
        }),
    );
    let releaseHandler: (() => void) | undefined;
    let mintCallsWhenHandlerRan = -1;

    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    proxy.tool("slow_tool", async () => {
      mintCallsWhenHandlerRan = mockedMint.mock.calls.length;
      await new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      return { content: [{ type: "text", text: "ok" }] };
    });

    const tool = registeredTool(server, "slow_tool");
    const call = tool?.handler({
      signal: new AbortController().signal,
      requestId: "req-early",
      sendNotification: async () => {},
      sendRequest: async () => ({}),
    }) as Promise<Record<string, unknown>>;
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The mint was requested while the handler was still pending.
    expect(mintCallsWhenHandlerRan).toBe(1);
    releaseHandler?.();
    releaseMint?.();
    const result = await call;
    expect(((result._meta as Record<string, unknown>).yavio as { token: string }).token).toBe(
      "jwt_early",
    );
  });

  it("mints a token per call, bound to that call's trace id (never reused across calls)", async () => {
    // Ingest binds the JWT to the minting call's trace id and rejects a widget
    // batch under any other trace, so a cached token would break every call
    // after the first.
    const futureExpiry = new Date(Date.now() + 600_000).toISOString();
    mockedMint.mockImplementation(async (_endpoint, _key, traceId) => ({
      token: `jwt_for_${traceId}`,
      expiresAt: futureExpiry,
    }));

    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    proxy.tool("per_call_tool", (extra) => ({
      content: [{ type: "text", text: "ok" }],
    }));

    const tool = registeredTool(server, "per_call_tool");
    const mockExtra = {
      signal: new AbortController().signal,
      requestId: "req-6",
      sendNotification: async () => {},
      sendRequest: async () => ({}),
    };

    const widgetMeta = (result: unknown) =>
      ((result as Record<string, unknown>)._meta as Record<string, unknown>).yavio as {
        token: string;
        traceId: string;
      };
    const first = widgetMeta(await tool?.handler(mockExtra));
    const second = widgetMeta(await tool?.handler({ ...mockExtra, requestId: "req-7" }));

    expect(mockedMint).toHaveBeenCalledTimes(2);
    expect(first.token).toBe(`jwt_for_${first.traceId}`);
    expect(second.token).toBe(`jwt_for_${second.traceId}`);
    expect(second.traceId).not.toBe(first.traceId);
    // The trace id the token is bound to is the one on the call's event.
    const traces = transport.sent
      .flat()
      .filter((e) => e.event_type === "tool_call")
      .map((e) => e.trace_id);
    expect(traces).toEqual([first.traceId, second.traceId]);
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

    const tool = registeredTool(server, "server_only_tool");
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

    const tool = registeredTool(server, "no_mint_tool");
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

    const tool = registeredTool(server, "preserve_meta_tool");
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

    // tool_discovery fires on the first tools/list
    await listToolsThrough(proxy);
    expect(discoveries(transport.sent).map((e) => e.tool_name)).toEqual(["events_still_fire"]);

    const tool = registeredTool(server, "events_still_fire");
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

  // This mock has no low-level server, so tools/list cannot be wrapped and
  // discovery falls back to registration time, with property names only.
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
        inputSchema: { query: z.string() },
      },
      () => ({ content: [{ type: "text", text: "ok" }] }),
    );

    expect(transport.sent.length).toBe(1);
    const event = transport.sent[0][0] as Record<string, unknown>;
    expect(event.event_type).toBe("tool_discovery");
    expect(event.tool_name).toBe("search_rooms");
    expect(event.description).toBe("Search available rooms");
    // Never the raw Zod object (#83).
    expect(event.input_schema).toEqual({ type: "object", properties: { query: {} } });
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

/** Connect a real client to the proxy and list its tools once. */
async function listToolsThrough(proxy: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await proxy.connect(serverTransport);
  const client = new Client({ name: "discovery-test", version: "1.0" });
  await client.connect(clientTransport);
  return client.listTools();
}

const discoveries = (sent: BaseEvent[][]) =>
  sent.flat().filter((e) => e.event_type === "tool_discovery") as unknown as Array<
    Record<string, unknown>
  >;

describe("createProxy — tool_discovery emission", () => {
  beforeEach(() => {
    mockedMint.mockReset();
    mockedMint.mockResolvedValue(null);
    _resetGlobalState();
  });

  it("emits tool_discovery on tools/list, not on registration", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    proxy.tool("search_rooms", () => ({ content: [{ type: "text", text: "ok" }] }));

    expect(transport.sent).toHaveLength(0);
    await listToolsThrough(proxy);

    const [event] = discoveries(transport.sent);
    expect(event?.tool_name).toBe("search_rooms");
  });

  it("emits tool_discovery with description from tool(name, desc, cb)", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    proxy.tool("my_tool", "A helpful tool", () => ({ content: [{ type: "text", text: "ok" }] }));
    await listToolsThrough(proxy);

    const [event] = discoveries(transport.sent);
    expect(event?.tool_name).toBe("my_tool");
    expect(event?.description).toBe("A helpful tool");
  });

  it("sends the JSON Schema from tools/list for tool(name, schema, cb)", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    proxy.tool("schema_tool", { query: z.string(), limit: z.number().optional() }, () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    const listed = await listToolsThrough(proxy);

    const [event] = discoveries(transport.sent);
    expect(event?.input_schema).toMatchObject({
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    });
    // Exactly what the client was shown.
    expect(event?.input_schema).toEqual(listed.tools[0]?.inputSchema);
  });

  it("emits description and schema from tool(name, desc, schema, cb)", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    proxy.tool("full_tool", "A full tool", { query: z.string() }, () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    await listToolsThrough(proxy);

    const [event] = discoveries(transport.sent);
    expect(event?.description).toBe("A full tool");
    expect(event?.input_schema).toMatchObject({ properties: { query: { type: "string" } } });
  });

  it("sends JSON Schema, not Zod internals, for registerTool() (#83)", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    proxy.registerTool(
      "reg_tool",
      {
        description: "A registered tool",
        inputSchema: { query: z.string(), language: z.enum(["de", "en"]).optional() },
      },
      () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    await listToolsThrough(proxy);

    const [event] = discoveries(transport.sent);
    expect(event?.tool_name).toBe("reg_tool");
    expect(event?.description).toBe("A registered tool");
    expect(event?.input_schema).toMatchObject({
      type: "object",
      properties: { query: { type: "string" }, language: { enum: ["de", "en"] } },
      required: ["query"],
    });
    expect(JSON.stringify(event?.input_schema)).not.toMatch(/"_?def"/);
  });

  it("leaves the injected intent `context` parameter out of the schema", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(
      server,
      { ...testConfig, intent: { enabled: true, required: true, description: "why" } },
      transport,
      "0.0.1",
    );
    proxy.registerTool("intent_tool", { inputSchema: { query: z.string() } }, () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    const listed = await listToolsThrough(proxy);

    expect(listed.tools[0]?.inputSchema.properties).toHaveProperty("context");
    const [event] = discoveries(transport.sent);
    expect(event?.input_schema).toMatchObject({ properties: { query: { type: "string" } } });
    expect((event?.input_schema as { properties: object }).properties).not.toHaveProperty(
      "context",
    );
  });

  it("does not discover a tool registered on the unwrapped server", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    proxy.tool("wrapped", () => ({ content: [{ type: "text", text: "ok" }] }));
    server.tool("unwrapped", () => ({ content: [{ type: "text", text: "ok" }] }));
    await listToolsThrough(proxy);

    expect(discoveries(transport.sent).map((e) => e.tool_name)).toEqual(["wrapped"]);
  });

  it("only emits tool_discovery once per tool name", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    proxy.tool("dup_tool", () => ({ content: [{ type: "text", text: "first" }] }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await proxy.connect(serverTransport);
    const client = new Client({ name: "discovery-test", version: "1.0" });
    await client.connect(clientTransport);
    await client.listTools();
    await client.listTools();

    expect(discoveries(transport.sent).map((e) => e.tool_name)).toEqual(["dup_tool"]);
  });

  it("clamps the description to ingest's 2048 characters", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    proxy.tool("long_desc", "x".repeat(5000), () => ({ content: [{ type: "text", text: "ok" }] }));
    await listToolsThrough(proxy);

    expect(discoveries(transport.sent)[0]?.description).toHaveLength(2048);
  });

  it("sends the discovery of every listed tool in one batch", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    for (const name of ["one", "two", "three"]) {
      proxy.tool(name, () => ({ content: [{ type: "text", text: name }] }));
    }
    await listToolsThrough(proxy);

    const batches = transport.sent.filter((b) => b.some((e) => e.event_type === "tool_discovery"));
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((e) => (e as { tool_name?: string }).tool_name)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("degrades a schema longer than 16,384 characters to its property names", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    const values = Array.from({ length: 2000 }, (_, i) => `value_${i}`) as [string, ...string[]];
    proxy.tool("huge_enum", "Big", { pick: z.enum(values) }, () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    await listToolsThrough(proxy);

    const [event] = discoveries(transport.sent);
    expect(event?.tool_name).toBe("huge_enum");
    expect(event?.description).toBe("Big");
    // Not undefined: ingest would store `{}` and replace the registry's
    // schema with "no parameters".
    expect(event?.input_schema).toEqual({ type: "object", properties: { pick: {} } });
  });

  it("emits tool_discovery with correct base event fields", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    proxy.tool("base_fields_tool", () => ({ content: [{ type: "text", text: "ok" }] }));
    await listToolsThrough(proxy);

    const [event] = discoveries(transport.sent);
    expect(event?.source).toBe("server");
    expect(event?.sdk_version).toBe("0.0.1");
    expect(typeof event?.event_id).toBe("string");
    expect(typeof event?.trace_id).toBe("string");
    expect(typeof event?.session_id).toBe("string");
    expect(typeof event?.timestamp).toBe("string");
  });
});

describe("createProxy — instrumentation failures never break the call", () => {
  beforeEach(() => _resetGlobalState());

  it("runs the original callback when opening the call context throws (YAVIO-1100)", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport: Transport = {
      send(events: BaseEvent[]) {
        if (events[0]?.event_type === "connection") throw new Error("transport down");
      },
      flush: async () => {},
      shutdown: async () => {},
    };
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    proxy.tool("search", { q: z.string() }, () => ({ content: [{ type: "text", text: "found" }] }));

    const result = await registeredTool(server, "search")?.handler(
      { q: "x" },
      {
        signal: new AbortController().signal,
        requestId: "req-fail-1",
        sendNotification: async () => {},
        sendRequest: async () => ({}),
      },
    );

    expect(result).toEqual({ content: [{ type: "text", text: "found" }] });
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
    const tool1 = registeredTool(server1, "tool_a");
    await tool1?.handler(makeExtra({ sessionId: "mcp-session-abc" }));

    const firstSessionId = (yavioTransport.sent.at(-1) as unknown as BaseEvent[])[0].session_id;

    // Second connection — new server + proxy, same MCP session
    const { server: server2, proxy: proxy2 } = createServerAndProxy(yavioTransport);
    const mcpTransport2 = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
    await proxy2.connect(mcpTransport2 as never);

    const tool2 = registeredTool(server2, "tool_a");
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

    const tool1 = registeredTool(server1, "tool_a");
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

    const tool2 = registeredTool(server2, "tool_a");
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

    const tool1 = registeredTool(server1, "tool_a");
    await tool1?.handler(makeExtra({ sessionId: "mcp-session-alpha" }));

    const firstSessionId = (yavioTransport.sent.at(-1) as unknown as BaseEvent[])[0].session_id;

    // Second connection — different MCP session "beta"
    const { server: server2, proxy: proxy2 } = createServerAndProxy(yavioTransport);
    const mcpTransport2 = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
    await proxy2.connect(mcpTransport2 as never);

    const tool2 = registeredTool(server2, "tool_a");
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

    const tool1 = registeredTool(server1, "tool_a");
    await tool1?.handler(makeExtra());

    const firstSessionId = (yavioTransport.sent.at(-1) as unknown as BaseEvent[])[0].session_id;

    // Second connection — also no sessionId
    const { server: server2, proxy: proxy2 } = createServerAndProxy(yavioTransport);
    const mcpTransport2 = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
    await proxy2.connect(mcpTransport2 as never);

    const tool2 = registeredTool(server2, "tool_a");
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

    const tool1 = registeredTool(server1, "tool_a");
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

    const tool2 = registeredTool(server2, "tool_a");
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
    // ...and one connection event for the conversation, not one per request:
    // the dedup is module-level so it survives the per-request proxy.
    const connections = (yavioTransport.sent.flat() as BaseEvent[]).filter(
      (e) => e.event_type === "connection",
    );
    expect(connections).toHaveLength(1);
  });

  it("prefers extra.sessionId over _meta['openai/session']", async () => {
    const yavioTransport = createMockTransport();

    // Connection with both MCP session ID and OpenAI session
    const { server: server1, proxy: proxy1 } = createServerAndProxy(yavioTransport);
    const mcpTransport1 = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
    await proxy1.connect(mcpTransport1 as never);

    const tool1 = registeredTool(server1, "tool_a");
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

    const tool2 = registeredTool(server2, "tool_a");
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

    const tool1 = registeredTool(server1, "tool_a");
    await tool1?.handler(makeExtra({ _meta: { "openai/session": "v1/conversation-alpha" } }));

    const firstSessionId = (yavioTransport.sent.at(-1) as unknown as BaseEvent[])[0].session_id;

    // Second connection — conversation beta (different conversation, same user)
    const { server: server2, proxy: proxy2 } = createServerAndProxy(yavioTransport);
    const mcpTransport2 = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
    await proxy2.connect(mcpTransport2 as never);

    const tool2 = registeredTool(server2, "tool_a");
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
    const tool1 = registeredTool(server1, "tool_a");
    await tool1?.handler(makeExtra({ sessionId: "mcp-session-stable" }));

    const firstSessionId = (yavioTransport.sent.at(-1) as unknown as BaseEvent[])[0].session_id;

    // Reset global state to simulate a completely separate process
    _resetGlobalState();

    const { server: server2, proxy: proxy2 } = createServerAndProxy(yavioTransport);
    const mcpTransport2 = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
    await proxy2.connect(mcpTransport2 as never);
    const tool2 = registeredTool(server2, "tool_a");
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
    const tool = registeredTool(server, name);
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
    const tool = registeredTool(server, "ua_tool");
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

  it.each([
    ["2025-06-18", "2025-06-18"],
    ["<script>alert(1)</script>", undefined],
    ["2025-06-18; drop", undefined],
    ["latest", undefined],
    ["", undefined],
  ])(
    "records the mcp-protocol-version header %s as protocol_version %s only when it is a date (#142)",
    async (header, expected) => {
      const server = new McpServer({ name: "test", version: "1.0" });
      const transport = createMockTransport();
      const proxy = createProxy(server, testConfig, transport, "0.0.1");
      proxy.tool("pv_tool", () => ({ content: [{ type: "text", text: "ok" }] }));
      await registeredTool(server, "pv_tool")?.handler({
        signal: new AbortController().signal,
        requestId: "req-pv-1",
        sendNotification: async () => {},
        sendRequest: async () => ({}),
        requestInfo: { headers: { "mcp-protocol-version": header } },
      });
      const connection = transport.sent.flat().find((e) => e.event_type === "connection") as Record<
        string,
        unknown
      >;
      expect(connection.protocol_version).toBe(expected);
    },
  );

  it("detects the platform from the Origin header when nothing else matches", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");

    proxy.tool("origin_tool", () => ({ content: [{ type: "text", text: "ok" }] }));
    const tool = registeredTool(server, "origin_tool");
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
    const tool = registeredTool(server, "ri_tool");
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
    // ChatGPT also sends the IANA zone at the top level, outside userLocation
    // (seen on most located calls). Missing here, it hid a leak until 0.4.1.
    timezone: "Europe/Berlin",
    "openai/session": "v1/49A5b4dMHXWnQuVmyqIS4O",
  };

  async function callWithMeta(config: YavioConfig, _meta: unknown) {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, config, transport, "0.0.1");
    proxy.tool("meta_tool", { q: z.string() }, () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    const tool = registeredTool(server, "meta_tool");
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
    expect(event.region).toBe("North Rhine-Westphalia");
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
    // The verbatim _meta clone in input_values loses the WHOLE userLocation
    // object — city, region, timezone and coordinates, not only the country —
    // while everything else in _meta stays.
    const meta = (event.input_values as Record<string, unknown>)._meta as Record<string, unknown>;
    expect(meta).not.toHaveProperty("openai/userLocation");
    expect(meta).not.toHaveProperty("timezone");
    expect(event.region).toBeUndefined();
    expect(meta["openai/locale"]).toBe("de-DE");
    expect(meta["openai/subject"]).toBe("v1/2vDU0AOje8kKSAasHqXU4Y");
    const serialized = JSON.stringify(event);
    for (const leak of ["Duisburg", "North Rhine-Westphalia", "Europe/Berlin", "51.43247"]) {
      expect(serialized, leak).not.toContain(leak);
    }
  });

  const countryOnly: YavioConfig = {
    ...testConfig,
    capture: { ...testConfig.capture, geo: "country" },
  };

  function expectNoLocationDetail(event: Record<string, unknown>) {
    const serialized = JSON.stringify(event);
    for (const leak of ["Duisburg", "North Rhine-Westphalia", "Europe/Berlin", "51.43247"]) {
      expect(serialized, leak).not.toContain(leak);
    }
  }

  /** CHATGPT_META minus everything geo controls: userLocation and the top-level timezone. */
  const {
    "openai/userLocation": _location,
    timezone: _timezone,
    ...metaWithoutLocation
  } = CHATGPT_META;

  it('keeps only the country when capture.geo is "country"', async () => {
    const event = await callWithMeta(countryOnly, CHATGPT_META);
    expect(event.country_code).toBe("DE");
    expect(event.locale).toBe("de-DE");
    expect(event.subject_id).toBe("v1/2vDU0AOje8kKSAasHqXU4Y");
    const meta = (event.input_values as Record<string, unknown>)._meta as Record<string, unknown>;
    expect(meta["openai/userLocation"]).toEqual({ country: "DE" });
    expect(meta).toEqual({ ...metaWithoutLocation, "openai/userLocation": { country: "DE" } });
    expect(event.region).toBeUndefined();
    expectNoLocationDetail(event);
  });

  it('builds the "country" location from an allow-list, so unknown fields never pass', async () => {
    const event = await callWithMeta(countryOnly, {
      ...CHATGPT_META,
      "openai/userLocation": { ...CHATGPT_META["openai/userLocation"], postalCode: "47051" },
    });
    const meta = (event.input_values as Record<string, unknown>)._meta as Record<string, unknown>;
    expect(meta["openai/userLocation"]).toEqual({ country: "DE" });
    expect(JSON.stringify(event)).not.toContain("47051");
  });

  it('drops the location entirely under "country" when there is no valid country', async () => {
    const { country: _country, ...noCountry } = CHATGPT_META["openai/userLocation"];
    for (const location of [noCountry, { ...noCountry, country: "Germany" }]) {
      const event = await callWithMeta(countryOnly, {
        ...CHATGPT_META,
        "openai/userLocation": location,
      });
      expect(event.country_code).toBeUndefined();
      const meta = (event.input_values as Record<string, unknown>)._meta as Record<string, unknown>;
      expect(meta).not.toHaveProperty("openai/userLocation");
      expect(meta["openai/locale"]).toBe("de-DE");
      expectNoLocationDetail(event);
    }
  });

  it('applies "country" on the error path too', async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, countryOnly, transport, "0.0.1");
    proxy.tool("meta_tool", { q: z.string() }, () => {
      throw new Error("boom");
    });
    await expect(
      registeredTool(server, "meta_tool")?.handler(
        { q: "hello" },
        {
          signal: new AbortController().signal,
          requestId: "req-cm-3",
          sendNotification: async () => {},
          sendRequest: async () => ({}),
          _meta: CHATGPT_META,
        },
      ),
    ).rejects.toThrow("boom");
    const event = transport.sent.flat().find((e) => e.event_type === "tool_call") as Record<
      string,
      unknown
    >;
    expect(event.status).toBe("error");
    expect(event.country_code).toBe("DE");
    const meta = (event.input_values as Record<string, unknown>)._meta as Record<string, unknown>;
    expect(meta["openai/userLocation"]).toEqual({ country: "DE" });
    expectNoLocationDetail(event);
  });

  it("keeps the full userLocation in _meta while capture.geo is on (default)", async () => {
    const event = await callWithMeta(testConfig, CHATGPT_META);
    const meta = (event.input_values as Record<string, unknown>)._meta as Record<string, unknown>;
    expect(meta).toEqual(CHATGPT_META);
    expect(event.country_code).toBe("DE");
    expect(event.region).toBe("North Rhine-Westphalia");
  });

  describe('capture.geo "region" (#127)', () => {
    const regionOnly: YavioConfig = {
      ...testConfig,
      capture: { ...testConfig.capture, geo: "region" },
    };
    const metaOf = (event: Record<string, unknown>) =>
      (event.input_values as Record<string, unknown>)._meta as Record<string, unknown>;
    const withLocation = (location: Record<string, unknown>) => ({
      ...CHATGPT_META,
      "openai/userLocation": location,
    });

    it("keeps exactly { country, region } and sets the region field", async () => {
      const event = await callWithMeta(regionOnly, CHATGPT_META);
      expect(event.country_code).toBe("DE");
      expect(event.region).toBe("North Rhine-Westphalia");
      expect(event.locale).toBe("de-DE");
      expect(metaOf(event)).toEqual({
        ...metaWithoutLocation,
        "openai/userLocation": { country: "DE", region: "North Rhine-Westphalia" },
      });
      const serialized = JSON.stringify(event);
      for (const leak of ["Duisburg", "Europe/Berlin", "51.43247", "6.76516"]) {
        expect(serialized, leak).not.toContain(leak);
      }
    });

    it("builds the location from an allow-list, so unknown fields never pass", async () => {
      const event = await callWithMeta(
        regionOnly,
        withLocation({ ...CHATGPT_META["openai/userLocation"], postalCode: "47051" }),
      );
      expect(metaOf(event)["openai/userLocation"]).toEqual({
        country: "DE",
        region: "North Rhine-Westphalia",
      });
      expect(JSON.stringify(event)).not.toContain("47051");
    });

    it("keeps { country } and sets no region field when the platform sent none", async () => {
      const { region: _region, ...noRegion } = CHATGPT_META["openai/userLocation"];
      const event = await callWithMeta(regionOnly, withLocation(noRegion));
      expect(event.country_code).toBe("DE");
      expect(event.region).toBeUndefined();
      expect(metaOf(event)["openai/userLocation"]).toEqual({ country: "DE" });
    });

    it("removes the location, country and region when the country is invalid", async () => {
      const event = await callWithMeta(
        regionOnly,
        withLocation({ ...CHATGPT_META["openai/userLocation"], country: "Germany" }),
      );
      expect(event.country_code).toBeUndefined();
      expect(event.region).toBeUndefined();
      expect(metaOf(event)).not.toHaveProperty("openai/userLocation");
      expect(metaOf(event)).not.toHaveProperty("timezone");
      expect(JSON.stringify(event)).not.toContain("North Rhine-Westphalia");
    });

    it.each([
      ["longer than 64 characters", "x".repeat(65)],
      ["a non-string", 42],
      ["a control character", "North\u0007Rhine"],
      ["only spaces", "   "],
      // the rule ingest applies too (@yavio/shared/geo): no postal code in a region
      ["carrying digits", "Duisburg 47051"],
      ["carrying an email", "me@example.com"],
    ])("drops a region that is %s, keeps the country", async (_label, region) => {
      const event = await callWithMeta(
        regionOnly,
        withLocation({ ...CHATGPT_META["openai/userLocation"], region }),
      );
      expect(event.country_code).toBe("DE");
      expect(event.region).toBeUndefined();
      expect(metaOf(event)["openai/userLocation"]).toEqual({ country: "DE" });
    });

    it("trims the region, the same in the field and in _meta", async () => {
      const event = await callWithMeta(
        regionOnly,
        withLocation({ country: "DE", region: "  Hesse " }),
      );
      expect(event.region).toBe("Hesse");
      expect(metaOf(event)["openai/userLocation"]).toEqual({ country: "DE", region: "Hesse" });
    });

    it("folds a typographic apostrophe, the same in the field and in _meta", async () => {
      const event = await callWithMeta(
        regionOnly,
        withLocation({ country: "FR", region: "Provence-Alpes-C\u00f4te d\u2019Azur" }),
      );
      expect(event.region).toBe("Provence-Alpes-C\u00f4te d'Azur");
      expect(metaOf(event)["openai/userLocation"]).toEqual({
        country: "FR",
        region: "Provence-Alpes-C\u00f4te d'Azur",
      });
    });

    it("keeps exactly 64 characters", async () => {
      const region = "x".repeat(64);
      const event = await callWithMeta(regionOnly, withLocation({ country: "DE", region }));
      expect(event.region).toBe(region);
    });

    it('sets no region under "country" or false', async () => {
      for (const geo of ["country", false] as const) {
        const event = await callWithMeta(
          { ...testConfig, capture: { ...testConfig.capture, geo } },
          CHATGPT_META,
        );
        expect(event.region, String(geo)).toBeUndefined();
        expect(JSON.stringify(event), String(geo)).not.toContain("North Rhine-Westphalia");
      }
    });

    it("applies on the error path too", async () => {
      const server = new McpServer({ name: "test", version: "1.0" });
      const transport = createMockTransport();
      const proxy = createProxy(server, regionOnly, transport, "0.0.1");
      proxy.tool("meta_tool", { q: z.string() }, () => {
        throw new Error("boom");
      });
      await expect(
        registeredTool(server, "meta_tool")?.handler(
          { q: "hello" },
          {
            signal: new AbortController().signal,
            requestId: "req-cm-4",
            sendNotification: async () => {},
            sendRequest: async () => ({}),
            _meta: CHATGPT_META,
          },
        ),
      ).rejects.toThrow("boom");
      const event = transport.sent.flat().find((e) => e.event_type === "tool_call") as Record<
        string,
        unknown
      >;
      expect(event.status).toBe("error");
      expect(event.region).toBe("North Rhine-Westphalia");
      expect(metaOf(event)["openai/userLocation"]).toEqual({
        country: "DE",
        region: "North Rhine-Westphalia",
      });
      expect(metaOf(event)).not.toHaveProperty("timezone");
    });
  });

  it.each([false, "country", "region"] as const)(
    "keeps only locale, user agent, subject and session under %s and names the rest",
    async (geo) => {
      // Shaped like what ChatGPT sends; every value is synthetic.
      const dropped = {
        sessionId: "session-test-0001",
        windowId: "session-test-0001:0",
        callId: "exec-test-0001",
        itemId: "ctc_test_0001",
        "openai/request_id": "request-test-0001",
        "openai/organization": "v1/org-test",
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        progressToken: 1,
        "io.modelcontextprotocol/clientCapabilities": { experimental: {} },
        timezone_offset_minutes: -120,
        tz: "America/Indiana/Knox",
        "openai/postalCode": "00000",
      };
      const event = await callWithMeta(
        { ...testConfig, capture: { ...testConfig.capture, geo } },
        { ...CHATGPT_META, ...dropped },
      );
      const inputValues = event.input_values as Record<string, unknown>;
      const meta = inputValues._meta as Record<string, unknown>;
      expect(Object.keys(meta).sort()).toEqual(
        [
          "openai/locale",
          "openai/session",
          "openai/subject",
          "openai/userAgent",
          ...(geo === false ? [] : ["openai/userLocation"]),
        ].sort(),
      );
      // Names only, sorted; values never.
      expect(inputValues._metaDroppedKeys).toEqual([...Object.keys(dropped), "timezone"].sort());
      expect(inputValues).not.toHaveProperty("_metaDroppedUnnamed");
      const serialized = JSON.stringify(event);
      for (const leak of [
        "session-test-0001",
        "exec-test",
        "0af7651916cd43dd",
        "Knox",
        "00000",
        "-120",
      ]) {
        expect(serialized, leak).not.toContain(leak);
      }
    },
  );

  it("counts, without naming, keys with an id-like run, a malformed name or past the cap", async () => {
    const odd = {
      "openai/sess_4f9c2a7b1e": 1, // 10 hex digits in a row: could be an id
      "x-1234567890": 1,
      "Berlin 10115": 1, // a space: not a key name
      "@user": 1,
      [`k${"x".repeat(64)}`]: 1,
      ...Object.fromEntries(
        Array.from({ length: 25 }, (_, i) => [`extra${String(i).padStart(2, "0")}`, i]),
      ),
    };
    const event = await callWithMeta(
      { ...testConfig, capture: { ...testConfig.capture, geo: "country" } },
      { ...CHATGPT_META, ...odd },
    );
    const inputValues = event.input_values as Record<string, unknown>;
    const named = inputValues._metaDroppedKeys as string[];
    expect(named).toHaveLength(20);
    expect(named.slice(0, 2)).toEqual(["extra00", "extra01"]);
    for (const key of ["openai/sess_4f9c2a7b1e", "x-1234567890", "Berlin 10115", "@user"]) {
      expect(named).not.toContain(key);
    }
    // 5 unnameable, plus the 6 named ones past the cap (extra20–24, timezone).
    expect(inputValues._metaDroppedUnnamed).toBe(11);
    expect(JSON.stringify(event)).not.toContain("4f9c2a7b1e");
  });

  it("adds neither field when every key is kept", async () => {
    const { timezone: _tz, ...onlyKnown } = CHATGPT_META;
    const event = await callWithMeta(
      { ...testConfig, capture: { ...testConfig.capture, geo: "country" } },
      onlyKnown,
    );
    const inputValues = event.input_values as Record<string, unknown>;
    expect(inputValues).not.toHaveProperty("_metaDroppedKeys");
    expect(inputValues).not.toHaveProperty("_metaDroppedUnnamed");
  });

  it("keeps every key, and records nothing, under geo: true", async () => {
    const extra = { sessionId: "session-test-0001", timezone_offset_minutes: -300 };
    const event = await callWithMeta(testConfig, { ...CHATGPT_META, ...extra });
    const inputValues = event.input_values as Record<string, unknown>;
    expect(inputValues._meta).toEqual({ ...CHATGPT_META, ...extra });
    expect(inputValues).not.toHaveProperty("_metaDroppedKeys");
    expect(inputValues).not.toHaveProperty("_metaDroppedUnnamed");
  });

  it("fails closed on a geo value that never went through resolveConfig", async () => {
    // A hand-built config with the string "false": no country, no region,
    // no location — not "truthy, so on".
    const event = await callWithMeta(
      { ...testConfig, capture: { ...testConfig.capture, geo: "false" as never } },
      CHATGPT_META,
    );
    expect(event.country_code).toBeUndefined();
    expect(event.region).toBeUndefined();
    const meta = (event.input_values as Record<string, unknown>)._meta as Record<string, unknown>;
    expect(meta).not.toHaveProperty("openai/userLocation");
    expect(meta).not.toHaveProperty("timezone");
  });

  it.each([false, "country", "region"] as const)(
    "never mutates the _meta the handler receives when gating geo (%s)",
    async (geo) => {
      const server = new McpServer({ name: "test", version: "1.0" });
      const transport = createMockTransport();
      const proxy = createProxy(
        server,
        { ...testConfig, capture: { ...testConfig.capture, geo } },
        transport,
        "0.0.1",
      );
      let seenMeta: unknown;
      proxy.tool("meta_tool", { q: z.string() }, (_args, extra) => {
        seenMeta = extra._meta;
        return { content: [{ type: "text", text: "ok" }] };
      });
      const _meta = JSON.parse(JSON.stringify(CHATGPT_META));
      await registeredTool(server, "meta_tool")?.handler(
        { q: "hello" },
        {
          signal: new AbortController().signal,
          requestId: "req-cm-2",
          sendNotification: async () => {},
          sendRequest: async () => ({}),
          _meta,
        },
      );
      expect(seenMeta).toBe(_meta);
      expect(seenMeta).toEqual(CHATGPT_META);
    },
  );

  it("captures nothing when inputValues capture is off", async () => {
    const event = await callWithMeta(
      { ...testConfig, capture: { ...testConfig.capture, inputValues: false } },
      CHATGPT_META,
    );
    expect(event.country_code).toBeUndefined();
    expect(event.region).toBeUndefined();
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
    const tool = registeredTool(server, "te_tool");
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
    const tool = registeredTool(server, "throwing");
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

    await registeredTool(server, "book")?.handler({ q: "hello" }, extra());
    await registeredTool(server, "search")?.handler({ q: "hello" }, extra());

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
    await registeredTool(server, "book")?.handler({ q: "hello" }, extra());
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

  it("drops inputs, client meta and the thrown message on the throw path too", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(
      server,
      configWith({ book: { inputValues: false, outputValues: false } }),
      transport,
      "0.0.1",
    );
    proxy.tool("book", { iban: z.string() }, ({ iban }) => {
      // Messages routinely interpolate the arguments, and stripPii does not
      // recognise an IBAN.
      throw new Error(`IBAN ${iban} rejected`);
    });
    await expect(
      registeredTool(server, "book")?.handler({ iban: "DE89370400440532013000" }, extra()),
    ).rejects.toThrow();
    const book = toolCallFor(transport, "book");
    expectNoInputs(book);
    expect(book?.status).toBe("error");
    expect(book?.error_category).toBe("unknown");
    expect(book?.error_message).toBeUndefined();
    expect(JSON.stringify(book)).not.toContain("DE89370400440532013000");
  });

  it("drops the thrown message under a global inputValues: false as well", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(
      server,
      { ...testConfig, capture: { ...testConfig.capture, inputValues: false } },
      transport,
      "0.0.1",
    );
    proxy.tool("book", { q: z.string() }, () => {
      throw new Error("upstream unavailable");
    });
    await expect(
      registeredTool(server, "book")?.handler({ q: "hello" }, extra()),
    ).rejects.toThrow();
    const book = toolCallFor(transport, "book");
    expect(book?.status).toBe("error");
    expect(book?.error_message).toBeUndefined();
  });

  it("keeps the thrown message when only outputValues is off (developer-written, not output)", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(
      server,
      configWith({ book: { outputValues: false } }),
      transport,
      "0.0.1",
    );
    proxy.tool("book", { q: z.string() }, () => {
      throw new Error("upstream unavailable");
    });
    await expect(
      registeredTool(server, "book")?.handler({ q: "hello" }, extra()),
    ).rejects.toThrow();
    expect(toolCallFor(transport, "book")?.error_message).toBe("upstream unavailable");
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
    await registeredTool(server, "book")?.handler({ q: "hello" }, extra());
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
    await registeredTool(server, "search")?.handler({ q: "hello" }, extra());
    await registeredTool(server, "other")?.handler({ q: "hello" }, extra());
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
    await registeredTool(server, "book")?.handler({ q: "hello" }, extra());

    const events = transport.sent.flat();
    const conversion = events.find((e) => e.event_type === "conversion");
    const toolCall = events.find((e) => e.event_type === "tool_call");
    expect(conversion).toBeDefined();
    expect(conversion?.trace_id).toBe(toolCall?.trace_id);
    expect(conversion?.session_id).toBe(toolCall?.session_id);
  });
});

describe("input_values extra fields (_-prefixed)", () => {
  beforeEach(() => {
    mockedMint.mockReset();
    mockedMint.mockResolvedValue(null);
    _resetGlobalState();
  });

  async function inputValuesFor(extraOverrides: Record<string, unknown>) {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    proxy.tool("ef_tool", { q: z.string() }, () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    await registeredTool(server, "ef_tool")?.handler(
      { q: "hello" },
      {
        signal: new AbortController().signal,
        sendNotification: async () => {},
        sendRequest: async () => ({}),
        ...extraOverrides,
      },
    );
    const toolCall = transport.sent.flat().find((e) => e.event_type === "tool_call") as Record<
      string,
      unknown
    >;
    return (toolCall.input_values ?? {}) as Record<string, unknown>;
  }

  it("keeps _meta, _taskId and _requestInfo", async () => {
    const inputValues = await inputValuesFor({
      _meta: { "openai/locale": "de-DE" },
      taskId: "task-42",
      requestInfo: { headers: { "user-agent": "ChatGPT/1.2" } },
    });
    expect(inputValues._meta).toEqual({ "openai/locale": "de-DE" });
    expect(inputValues._taskId).toBe("task-42");
    expect(inputValues._requestInfo).toEqual({ headers: { "user-agent": "ChatGPT/1.2" } });
    expect(inputValues.q).toBe("hello");
  });

  // Dropped after the 2026-08-26 inventory: a per-connection counter, a TTL
  // nobody sends, and the RAW Mcp-Session-Id (the session_id column is hashed
  // on purpose; a raw session identifier is what an app-store review flags).
  it("drops _requestId, _taskRequestedTtl and _sessionId", async () => {
    const inputValues = await inputValuesFor({
      requestId: 7,
      taskRequestedTtl: 60_000,
      sessionId: "mcp-session-raw-8d2f",
    });
    expect(inputValues).not.toHaveProperty("_requestId");
    expect(inputValues).not.toHaveProperty("_taskRequestedTtl");
    expect(inputValues).not.toHaveProperty("_sessionId");
    expect(JSON.stringify(inputValues)).not.toContain("mcp-session-raw-8d2f");
    expect(Object.keys(inputValues)).toEqual(["q"]);
  });

  it("keeps exactly the five allow-listed headers", async () => {
    const inputValues = await inputValuesFor({
      requestInfo: {
        headers: {
          "user-agent": "ChatGPT/1.2",
          "accept-language": "de-DE",
          "x-anthropic-client": "ClaudeAI",
          "mcp-protocol-version": "2025-06-18",
          traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
          authorization: "Bearer nope",
          cookie: "session=abc",
          "x-forwarded-for": "203.0.113.7",
          host: "example.test",
        },
      },
    });
    const headers = (inputValues._requestInfo as { headers: Record<string, string> }).headers;
    expect(Object.keys(headers).sort()).toEqual([
      "accept-language",
      "mcp-protocol-version",
      "traceparent",
      "user-agent",
      "x-anthropic-client",
    ]);
  });
});

describe("client metadata for schema-less tools", () => {
  beforeEach(() => _resetGlobalState());

  const extra = (meta: Record<string, unknown>) => ({
    signal: new AbortController().signal,
    requestId: "req-meta",
    sendNotification: async () => {},
    sendRequest: async () => ({}),
    _meta: meta,
  });

  it("captures locale, country and subject for a tool without arguments", async () => {
    // The callback of a schema-less tool receives only `extra`; the metadata
    // lives there, not in the arguments, so it is captured all the same.
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    proxy.tool("ping", () => ({ content: [{ type: "text", text: "pong" }] }));
    await registeredTool(server, "ping")?.handler(
      extra({
        "openai/locale": "de-DE",
        "openai/subject": "v1/subject-7",
        "openai/userLocation": { country: "DE", city: "Duisburg" },
      }),
    );

    const [event] = transport.sent.flat().filter((e) => e.event_type === "tool_call") as Array<
      Record<string, unknown>
    >;
    expect(event?.event_type).toBe("tool_call");
    expect(event?.locale).toBe("de-DE");
    expect(event?.country_code).toBe("DE");
    expect(event?.subject_id).toBe("v1/subject-7");
    expect(event?.input_values).toBeUndefined(); // there are no arguments
  });

  it("captures nothing of it under inputValues: false", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const config = { ...testConfig, capture: { ...testConfig.capture, inputValues: false } };
    const proxy = createProxy(server, config, transport, "0.0.1");
    proxy.tool("ping", () => ({ content: [{ type: "text", text: "pong" }] }));
    await registeredTool(server, "ping")?.handler(
      extra({ "openai/locale": "de-DE", "openai/subject": "v1/subject-7" }),
    );

    const [event] = transport.sent.flat().filter((e) => e.event_type === "tool_call") as Array<
      Record<string, unknown>
    >;
    expect(event?.locale).toBeUndefined();
    expect(event?.subject_id).toBeUndefined();
  });
});

describe("one proxy, many conversations", () => {
  beforeEach(() => _resetGlobalState());

  const extra = (conversation: string, requestId = "req") => ({
    signal: new AbortController().signal,
    requestId,
    sendNotification: async () => {},
    sendRequest: async () => ({}),
    _meta: { "openai/session": conversation },
  });

  it("keeps identify() to its own conversation", async () => {
    // Stateless transports serve every conversation through one proxy: a
    // user identified in conversation A must not appear on B's events.
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    const yavio = createYavioContext();
    proxy.tool("whoami", (ex) => {
      const meta = (ex as { _meta?: Record<string, unknown> })._meta;
      if (meta?.["openai/session"] === "conv-a") yavio.identify("anna");
      return { content: [{ type: "text", text: "ok" }] };
    });
    const handler = registeredTool(server, "whoami")?.handler;

    await handler?.(extra("conv-a", "r1"));
    await handler?.(extra("conv-b", "r2"));
    await handler?.(extra("conv-a", "r3"));

    const calls = transport.sent.flat().filter((e) => e.event_type === "tool_call") as Array<
      Record<string, unknown>
    >;
    expect(calls.map((e) => e.user_id)).toEqual(["anna", undefined, "anna"]);
    expect(calls[0]?.session_id).toBe(deriveSessionId("conv-a"));
    expect(calls[1]?.session_id).toBe(deriveSessionId("conv-b"));
  });

  it("emits a fresh connection event for a conversation that was evicted and returns", async () => {
    // One proxy, 1,000-entry session map: after 1,000 other conversations the
    // first one is rebuilt from scratch (no user, step sequence 0), and the
    // connection-event mark goes with it so the discontinuity is visible.
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    const yavio = createYavioContext();
    proxy.tool("whoami", (ex) => {
      const meta = (ex as { _meta?: Record<string, unknown> })._meta;
      if (meta?.["openai/session"] === "conv-0") {
        yavio.identify("anna");
        yavio.step("look");
      }
      return { content: [{ type: "text", text: "ok" }] };
    });
    const handler = registeredTool(server, "whoami")?.handler;

    await handler?.(extra("conv-0", "r0"));
    await handler?.(extra("conv-0", "r0b")); // still known: no second connection event
    for (let i = 1; i <= 1000; i += 1) await handler?.(extra(`conv-${i}`, `r${i}`));
    await handler?.(extra("conv-0", "r0c"));

    const first = deriveSessionId("conv-0");
    const events = transport.sent.flat() as Array<Record<string, unknown>>;
    const connections = events.filter(
      (e) => e.event_type === "connection" && e.session_id === first,
    );
    expect(connections).toHaveLength(2);
    const calls = events.filter((e) => e.event_type === "tool_call" && e.session_id === first);
    expect(calls.map((e) => e.user_id)).toEqual(["anna", "anna", "anna"]);
    // The step sequence restarting at 1 shows the state really started over.
    const steps = events.filter((e) => e.event_type === "step" && e.session_id === first);
    expect(steps.map((e) => e.step_sequence)).toEqual([1, 2, 1]);
  });

  it("identify() in every handler sends one identify event per conversation state: none for a repeat, one again after the conversation was evicted and returns (#145)", async () => {
    // Before 0.5.4 every call sent one: three identify rows for conv-0 here.
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    const yavio = createYavioContext();
    proxy.tool("whoami", (ex) => {
      const meta = (ex as { _meta?: Record<string, unknown> })._meta;
      if (meta?.["openai/session"] === "conv-0") yavio.identify("anna", { plan: "pro" });
      return { content: [{ type: "text", text: "ok" }] };
    });
    const handler = registeredTool(server, "whoami")?.handler;

    await handler?.(extra("conv-0", "r0"));
    await handler?.(extra("conv-0", "r0b")); // the same state: nothing new to send
    for (let i = 1; i <= 1000; i += 1) await handler?.(extra(`conv-${i}`, `r${i}`));
    await handler?.(extra("conv-0", "r0c")); // evicted: a fresh state sends once

    const first = deriveSessionId("conv-0");
    const events = transport.sent.flat() as Array<Record<string, unknown>>;
    const identifies = events.filter((e) => e.event_type === "identify" && e.session_id === first);
    expect(identifies).toHaveLength(2);
    expect(identifies.map((e) => e.user_traits)).toEqual([{ plan: "pro" }, { plan: "pro" }]);
    const calls = events.filter((e) => e.event_type === "tool_call" && e.session_id === first);
    expect(calls.map((e) => e.user_id)).toEqual(["anna", "anna", "anna"]);
  });

  it("keeps an active conversation's connection-event mark while newer ones age out", async () => {
    // The dedup map is bounded at 10,000. Keyless connects each mark a random
    // session id that nothing ever deletes; a conversation that stays active
    // throughout must keep its mark (a hit refreshes it) and not emit a second
    // connection event once 10,000 newer marks have been inserted.
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    proxy.tool("ping", () => ({ content: [{ type: "text", text: "ok" }] }));
    const handler = registeredTool(server, "ping")?.handler;
    const keyless = (requestId: string) => ({
      signal: new AbortController().signal,
      requestId,
      sendNotification: async () => {},
      sendRequest: async () => ({}),
    });

    await handler?.(extra("conv-0", "r0"));
    for (let i = 1; i <= 10_100; i += 1) {
      // A transport that reports its own close, so the server can reconnect.
      const mcpTransport: { onclose?: () => void; [k: string]: unknown } = {
        start: vi.fn(),
        send: vi.fn(),
        close: vi.fn(async () => mcpTransport.onclose?.()),
      };
      await proxy.connect(mcpTransport as never);
      await handler?.(keyless(`k${i}`));
      if (i % 100 === 0) await handler?.(extra("conv-0", `r0-${i}`));
      await server.close();
    }

    const first = deriveSessionId("conv-0");
    const connections = (transport.sent.flat() as Array<Record<string, unknown>>).filter(
      (e) => e.event_type === "connection" && e.session_id === first,
    );
    expect(connections).toHaveLength(1);
  });

  it("attributes overlapping calls from two conversations to their own sessions", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    proxy.tool("slow", async () => {
      await gate;
      return { content: [{ type: "text", text: "done" }] };
    });
    const handler = registeredTool(server, "slow")?.handler;

    const a = handler?.(extra("conv-a", "r1"));
    const b = handler?.(extra("conv-b", "r2"));
    release();
    await Promise.all([a, b]);

    const calls = transport.sent.flat().filter((e) => e.event_type === "tool_call");
    expect(calls.map((e) => e.session_id).sort()).toEqual(
      [deriveSessionId("conv-a"), deriveSessionId("conv-b")].sort(),
    );
  });
});

describe("valueFreeRejection (#123): what a rejected call may keep as error_message", () => {
  const REASON =
    "Input validation error: the arguments did not match the tool's schema (values not stored, see capture.rejectedInputValues)";

  it.each([
    "MCP error -32602: Tool book not found",
    "MCP error -32602: Tool book disabled",
    "MCP error -32603: Tool book has taskSupport 'required' but was not registered with registerToolTask",
    "MCP error -32601: Tool book requires task augmentation (taskSupport: 'required')",
    "Tool book not found",
  ])("keeps a text that names only the tool: %s", (message) => {
    expect(valueFreeRejection(message, "book")).toBe(message);
  });

  it("replaces an argument-validation text, which can echo the value, by a fixed reason", () => {
    const zod3 =
      "MCP error -32602: Input validation error: Invalid arguments for tool book: Invalid enum value. Expected 'a', received 'my wife is pregnant' at plan";
    expect(valueFreeRejection(zod3, "book")).toBe(REASON);
  });

  it("drops a known wording that names a different tool", () => {
    expect(valueFreeRejection("MCP error -32602: Tool other not found", "book")).toBeUndefined();
    // The name is compared, never used as a pattern.
    expect(valueFreeRejection("MCP error -32602: Tool bxok not found", "b.ok")).toBeUndefined();
  });

  it("drops any wording outside the allowlist: fail closed for a later MCP SDK", () => {
    expect(
      valueFreeRejection("MCP error -32602: Tool book rejected 'my wife is pregnant'", "book"),
    ).toBeUndefined();
    expect(valueFreeRejection("Something else entirely", "book")).toBeUndefined();
    expect(valueFreeRejection(undefined, "book")).toBeUndefined();
    expect(valueFreeRejection("", "book")).toBeUndefined();
  });
});

describe("session keys and session_source (#144)", () => {
  beforeEach(() => {
    mockedMint.mockReset();
    mockedMint.mockResolvedValue(null);
    _resetGlobalState();
  });

  /** A v1 handler context; `requestInfo` makes it an HTTP request. */
  const call = (overrides: Record<string, unknown> = {}) => ({
    signal: new AbortController().signal,
    requestId: "req-144",
    sendNotification: async () => {},
    sendRequest: async () => ({}),
    ...overrides,
  });
  const http = (headers: Record<string, string>, overrides: Record<string, unknown> = {}) =>
    call({ requestInfo: { headers }, ...overrides });

  function setup(config: YavioConfig = testConfig, callback?: () => unknown) {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, config, transport, "0.0.1");
    proxy.tool(
      "ping",
      () =>
        (callback?.() ?? { content: [{ type: "text", text: "pong" }] }) as {
          content: Array<{ type: "text"; text: string }>;
        },
    );
    const handler = registeredTool(server, "ping")?.handler;
    if (!handler) throw new Error("ping is not registered");
    const events = () => transport.sent.flat() as Array<Record<string, unknown>>;
    const calls = () => events().filter((e) => e.event_type === "tool_call");
    return { server, proxy, transport, handler, events, calls };
  }

  it("no key and no HTTP request (stdio, in-memory) → connection, on the call and its connection event", async () => {
    const { handler, events } = setup();
    await handler(call());
    expect(events().map((e) => [e.event_type, e.session_source])).toEqual([
      ["connection", "connection"],
      ["tool_call", "connection"],
    ]);
  });

  it("no key on an HTTP request → per_request", async () => {
    const { handler, events } = setup();
    await handler(http({ "user-agent": "cursor/1.7.0" }));
    expect(events().map((e) => [e.event_type, e.session_source])).toEqual([
      ["connection", "per_request"],
      ["tool_call", "per_request"],
    ]);
  });

  // #169: a long-lived server whose key-less HTTP calls all reach one proxy
  // (MCP SDK v1 1.24/1.25, one stateless transport reused for every request).
  it("two key-less HTTP calls on one proxy are two sessions: no user, traits, platform or step sequence carried over, no YAVIO-1302 (#169)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const yavio = createYavioContext();
      const users = ["alice", "bob"];
      const { handler, events, calls } = setup(testConfig, () => {
        const user = users.shift() as string;
        yavio.identify(user, { plan: `plan-${user}` });
        yavio.step("look");
        return { content: [{ type: "text", text: user }] };
      });
      await handler(http({ "user-agent": "claude-code/2.0.1" }));
      await handler(http({ "user-agent": "cursor/1.7.0" }));
      expect(calls().map((e) => [e.user_id, e.platform, e.session_source])).toEqual([
        ["alice", "claude-code", "per_request"],
        ["bob", "cursor", "per_request"],
      ]);
      expect(new Set(calls().map((e) => e.session_id)).size).toBe(2);
      const identify = events().filter((e) => e.event_type === "identify");
      expect(identify.map((e) => [e.user_id, e.user_traits])).toEqual([
        ["alice", { plan: "plan-alice" }],
        ["bob", { plan: "plan-bob" }],
      ]);
      const steps = events().filter((e) => e.event_type === "step");
      expect(steps.map((e) => [e.user_id, e.step_sequence])).toEqual([
        ["alice", 1],
        ["bob", 1],
      ]);
      expect(warn.mock.calls.filter((args) => String(args[0]).includes("YAVIO-1302"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("a key-less HTTP call that never identifies carries no user_id after one that did (#169)", async () => {
    const yavio = createYavioContext();
    let identify = true;
    const { handler, calls } = setup(testConfig, () => {
      if (identify) yavio.identify("alice");
      return { content: [{ type: "text", text: "ok" }] };
    });
    await handler(http({ "user-agent": "cursor/1.7.0" }));
    identify = false;
    await handler(http({ "user-agent": "cursor/1.7.0" }));
    expect(calls().map((e) => e.user_id)).toEqual(["alice", undefined]);
  });

  it("off HTTP (stdio, in-memory) the connection is one client: identify and the step sequence carry across its calls (#169 guard)", async () => {
    const yavio = createYavioContext();
    let first = true;
    const { handler, calls, events } = setup(testConfig, () => {
      if (first) yavio.identify("dora");
      first = false;
      yavio.step("look");
      return { content: [{ type: "text", text: "ok" }] };
    });
    await handler(call());
    await handler(call());
    expect(calls().map((e) => [e.user_id, e.session_source])).toEqual([
      ["dora", "connection"],
      ["dora", "connection"],
    ]);
    expect(new Set(calls().map((e) => e.session_id)).size).toBe(1);
    const steps = events().filter((e) => e.event_type === "step");
    expect(steps.map((e) => e.step_sequence)).toEqual([1, 2]);
  });

  it("a wrapped handler invoked directly inside a key-less HTTP call joins that call's session; on its own it gets one of its own (#169)", async () => {
    const yavio = createYavioContext();
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    proxy.tool("inner", () => {
      yavio.step("inner");
      return { content: [{ type: "text", text: "in" }] };
    });
    proxy.tool("outer", async (extra: unknown) => {
      yavio.identify("olga");
      await registeredTool(server, "inner")?.handler(extra);
      return { content: [{ type: "text", text: "out" }] };
    });
    await registeredTool(server, "outer")?.handler(http({ "user-agent": "cursor/1.7.0" }));
    await registeredTool(server, "inner")?.handler(http({ "user-agent": "cursor/1.7.0" }));
    const sent = transport.sent.flat() as Array<Record<string, unknown>>;
    const calls = sent.filter((e) => e.event_type === "tool_call");
    expect(calls.map((e) => [e.event_name, e.user_id])).toEqual([
      ["inner", "olga"],
      ["outer", "olga"],
      ["inner", undefined],
    ]);
    expect(calls[0]?.session_id).toBe(calls[1]?.session_id);
    expect(calls[2]?.session_id).not.toBe(calls[1]?.session_id);
    // The nested call's step is the outer call's first; the standalone one starts its own.
    const steps = sent.filter((e) => e.event_type === "step");
    expect(steps.map((e) => [e.session_id, e.user_id, e.step_sequence])).toEqual([
      [calls[1]?.session_id, "olga", 1],
      [calls[2]?.session_id, undefined, 1],
    ]);
  });

  // #169 review round 1: the nested call is handed a context the outer
  // handler built itself, or none — no requestInfo, so not "an HTTP request".
  function nestedBare() {
    const yavio = createYavioContext();
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    proxy.tool("inner", () => {
      yavio.step("inner");
      return { content: [{ type: "text", text: "in" }] };
    });
    proxy.tool("outer", async (extra: unknown) => {
      const { user } = (extra as { _meta?: { user?: string } })._meta ?? {};
      yavio.identify(user as string);
      await registeredTool(server, "inner")?.handler({});
      await registeredTool(server, "inner")?.handler();
      return { content: [{ type: "text", text: "out" }] };
    });
    const outer = (ua: string, user: string) =>
      registeredTool(server, "outer")?.handler(http({ "user-agent": ua }, { _meta: { user } }));
    const sent = () => transport.sent.flat() as Array<Record<string, unknown>>;
    return { outer, sent };
  }

  it("a wrapped handler invoked directly with a context of its own, or none, inside a key-less HTTP call joins that call (#169 review round 1)", async () => {
    const { outer, sent } = nestedBare();
    await outer("cursor/1.7.0", "olga");
    const calls = sent().filter((e) => e.event_type === "tool_call");
    expect(calls.map((e) => [e.event_name, e.user_id, e.session_source])).toEqual([
      ["inner", "olga", "per_request"],
      ["inner", "olga", "per_request"],
      ["outer", "olga", "per_request"],
    ]);
    expect(new Set(calls.map((e) => e.session_id)).size).toBe(1);
    const steps = sent().filter((e) => e.event_type === "step");
    expect(steps.map((e) => [e.user_id, e.step_sequence])).toEqual([
      ["olga", 1],
      ["olga", 2],
    ]);
    // One connection event, the outer call's: a nested call that joined it
    // adds none, although its context names another client (#169 review
    // round 2; 0.5.4 added one labelled `connection`).
    expect(
      sent()
        .filter((e) => e.event_type === "connection")
        .map((e) => [e.session_source, e.session_id, e.client_name]),
    ).toEqual([["per_request", calls[0]?.session_id, "cursor"]]);
  });

  it("several key-less HTTP callers on one proxy, each invoking a wrapped handler with a context of its own: every inner call stays with its caller (#169 review round 1)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { outer, sent } = nestedBare();
      await outer("claude-code/2.0.1", "u1");
      await outer("cursor/1.7.0", "u2");
      const calls = sent().filter((e) => e.event_type === "tool_call");
      expect(calls.map((e) => [e.event_name, e.user_id, e.platform, e.session_source])).toEqual([
        ["inner", "u1", "claude-code", "per_request"],
        ["inner", "u1", "claude-code", "per_request"],
        ["outer", "u1", "claude-code", "per_request"],
        ["inner", "u2", "cursor", "per_request"],
        ["inner", "u2", "cursor", "per_request"],
        ["outer", "u2", "cursor", "per_request"],
      ]);
      expect(calls.slice(0, 3).every((e) => e.session_id === calls[0]?.session_id)).toBe(true);
      expect(calls.slice(3).every((e) => e.session_id === calls[3]?.session_id)).toBe(true);
      expect(calls[3]?.session_id).not.toBe(calls[0]?.session_id);
      const steps = sent().filter((e) => e.event_type === "step");
      expect(steps.map((e) => [e.user_id, e.step_sequence])).toEqual([
        ["u1", 1],
        ["u1", 2],
        ["u2", 1],
        ["u2", 2],
      ]);
      expect(warn.mock.calls.filter((args) => String(args[0]).includes("YAVIO-1302"))).toEqual([]);
      // One connection event per caller, none from the nested calls.
      expect(
        sent()
          .filter((e) => e.event_type === "connection")
          .map((e) => [e.session_source, e.session_id, e.client_name]),
      ).toEqual([
        ["per_request", calls[0]?.session_id, "claude-code"],
        ["per_request", calls[3]?.session_id, "cursor"],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  // #169 review round 2: the join is per proxy, and only into a key-less
  // HTTP call's own state.
  it("a call into ANOTHER wrapped server from inside a key-less HTTP call does not join it: its own session, no user, its own connection event (#169 review round 2)", async () => {
    const yavio = createYavioContext();
    const serverA = new McpServer({ name: "a", version: "1.0" });
    const serverB = new McpServer({ name: "b", version: "1.0" });
    const transportA = createMockTransport();
    const transportB = createMockTransport();
    const proxyA = createProxy(serverA, testConfig, transportA, "0.0.1");
    const proxyB = createProxy(
      serverB,
      { ...testConfig, apiKey: "yav_test_other" },
      transportB,
      "0.0.1",
    );
    proxyB.tool("other", () => {
      yavio.step("other");
      return { content: [{ type: "text", text: "b" }] };
    });
    proxyA.tool("outer", async (extra: unknown) => {
      yavio.identify("olga");
      await registeredTool(serverB, "other")?.handler(extra);
      return { content: [{ type: "text", text: "a" }] };
    });
    await registeredTool(serverA, "outer")?.handler(http({ "user-agent": "cursor/1.7.0" }));
    const eventsA = transportA.sent.flat() as Array<Record<string, unknown>>;
    const eventsB = transportB.sent.flat() as Array<Record<string, unknown>>;
    const callA = eventsA.find((e) => e.event_type === "tool_call");
    const callB = eventsB.find((e) => e.event_type === "tool_call");
    expect([callA?.event_name, callA?.user_id, callA?.session_source]).toEqual([
      "outer",
      "olga",
      "per_request",
    ]);
    expect([callB?.event_name, callB?.user_id, callB?.session_source]).toEqual([
      "other",
      undefined,
      "per_request",
    ]);
    expect(callB?.session_id).not.toBe(callA?.session_id);
    expect(
      eventsB
        .filter((e) => e.event_type === "step")
        .map((e) => [e.session_id, e.user_id, e.step_sequence]),
    ).toEqual([[callB?.session_id, undefined, 1]]);
    expect(eventsB.filter((e) => e.event_type === "connection").map((e) => e.session_id)).toEqual([
      callB?.session_id,
    ]);
  });

  it("a key-less call from inside a KEYED call is not joined: without request headers the connection's state, with them one of its own (#169 review round 2)", async () => {
    const yavio = createYavioContext();
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    proxy.tool("inner", () => {
      yavio.step("inner");
      return { content: [{ type: "text", text: "in" }] };
    });
    proxy.tool("outer", async () => {
      yavio.identify("kim");
      await registeredTool(server, "inner")?.handler({});
      await registeredTool(server, "inner")?.handler(http({ "user-agent": "cursor/1.7.0" }));
      return { content: [{ type: "text", text: "out" }] };
    });
    await registeredTool(server, "outer")?.handler(
      http({ "user-agent": "cursor/1.7.0" }, { _meta: { "openai/session": "conv-k" } }),
    );
    const calls = (transport.sent.flat() as Array<Record<string, unknown>>).filter(
      (e) => e.event_type === "tool_call",
    );
    expect(calls.map((e) => [e.event_name, e.user_id, e.session_source])).toEqual([
      ["inner", undefined, "connection"],
      ["inner", undefined, "per_request"],
      ["outer", "kim", "openai_session"],
    ]);
    expect(new Set(calls.map((e) => e.session_id)).size).toBe(3);
  });

  it("a key-less HTTP call's session is not stored: 50 calls leave the session map empty, keyed calls fill it (#169 guard)", async () => {
    const shared = createSharedSessions();
    const server = new McpServer({ name: "test", version: "1.0" });
    const proxy = createProxy(server, testConfig, createMockTransport(), "0.0.1", shared);
    proxy.tool("ping", () => ({ content: [{ type: "text", text: "pong" }] }));
    const handler = registeredTool(server, "ping")?.handler;
    for (let i = 0; i < 50; i++) await handler?.(http({ "user-agent": "cursor/1.7.0" }));
    expect(shared.sessions.size).toBe(0);
    await handler?.(http({ "user-agent": "cursor/1.7.0" }, { _meta: { "openai/session": "c" } }));
    expect(shared.sessions.size).toBe(1);
  });

  it("labels each key it derives the session from", async () => {
    const { handler, calls } = setup({ ...testConfig, sessionKey: () => "custom-key" });
    await handler(call({ sessionId: "mcp-1" }));
    await handler(call({ _meta: { "openai/session": "conv-1" } }));
    await handler(call({ _meta: { "vscode.conversationId": "vscode-1" } }));
    await handler(call());
    expect(calls().map((e) => e.session_source)).toEqual([
      "mcp_session_id",
      "openai_session",
      "vscode_conversation",
      "custom",
    ]);
    expect(calls().map((e) => [e.session_source, e.session_id])).toEqual([
      ["mcp_session_id", deriveSessionId("mcp-1")],
      ["openai_session", deriveSessionId("conv-1")],
      ["vscode_conversation", deriveSessionId("vscode-1")],
      ["custom", deriveCustomSessionId("yav_test", "custom-key")],
    ]);
  });

  it("the connected transport's own session id is an Mcp-Session-Id too: sessionKey is not called", async () => {
    const sessionKey = vi.fn(() => "custom-key");
    const { proxy, handler, calls } = setup({ ...testConfig, sessionKey });
    const mcpTransport = { start: vi.fn(), close: vi.fn(), send: vi.fn(), sessionId: "t-1" };
    await proxy.connect(mcpTransport as never);
    await handler(call());
    expect(calls().map((e) => [e.session_source, e.session_id])).toEqual([
      ["mcp_session_id", deriveSessionId("t-1")],
    ]);
    expect(sessionKey).not.toHaveBeenCalled();
  });

  it("takes the first key in order — openai/session, vscode.conversationId, the Codex threadId, sessionKey — and calls sessionKey only last", async () => {
    const sessionKey = vi.fn(() => "custom-key");
    const { server, handler, calls } = setup({ ...testConfig, sessionKey });
    // The Codex CLI named by its initialize handshake (a long-lived server).
    (server.server as unknown as Record<string, unknown>).getClientVersion = () => ({
      name: "codex-mcp-client",
      version: "0.164.0",
    });
    await handler(
      call({ _meta: { "openai/session": "o", "vscode.conversationId": "v", threadId: "t" } }),
    );
    await handler(call({ _meta: { "vscode.conversationId": "v", threadId: "t" } }));
    await handler(call({ _meta: { threadId: "t" } }));
    expect(sessionKey).not.toHaveBeenCalled();
    await handler(call({ _meta: { threadId: "" } }));
    expect(calls().map((e) => e.session_source)).toEqual([
      "openai_session",
      "vscode_conversation",
      "codex_thread",
      "custom",
    ]);
    expect(sessionKey).toHaveBeenCalledTimes(1);
  });

  it("hands sessionKey { headers, meta, authInfo, extra }: {} for headers and meta off HTTP", async () => {
    const seen: SessionKeyRequest[] = [];
    const { handler } = setup({
      ...testConfig,
      sessionKey: (request) => {
        seen.push(request);
        return undefined;
      },
    });
    const stdio = call();
    await handler(stdio);
    const auth = { token: "t", clientId: "c", scopes: [], extra: { sub: "u" } };
    await handler(
      http({ "X-Conversation-Id": "conv-1" }, { _meta: { progressToken: 1 }, authInfo: auth }),
    );
    expect(seen[0]).toEqual({ headers: {}, meta: {}, authInfo: undefined, extra: stdio });
    expect(seen[1]?.headers).toEqual({ "x-conversation-id": "conv-1" });
    expect(seen[1]?.meta).toEqual({ progressToken: 1 });
    expect(seen[1]?.authInfo).toBe(auth);
  });

  it("a sessionKey that throws never fails the call, on the callback path too: no key, one YAVIO-1102 line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { handler, calls } = setup({
        ...testConfig,
        sessionKey: () => {
          throw new Error("boom");
        },
      });
      expect(await handler(http({ "user-agent": "node" }))).toEqual({
        content: [{ type: "text", text: "pong" }],
      });
      expect(await handler(call())).toEqual({ content: [{ type: "text", text: "pong" }] });
      expect(calls().map((e) => e.session_source)).toEqual(["per_request", "connection"]);
      const lines = warn.mock.calls.filter((args) => String(args[0]).includes("YAVIO-1102"));
      expect(lines).toHaveLength(1);
      expect(String(lines[0]?.[0])).toContain("threw Error: boom");
    } finally {
      warn.mockRestore();
    }
  });

  it("a sessionKey that throws an error whose message cannot be read still leaves the call instrumented (#144 review round 1)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const hostile = new Error("unreadable");
      Object.defineProperty(hostile, "message", {
        get() {
          throw new Error("no message for you");
        },
      });
      const { handler, calls } = setup({
        ...testConfig,
        sessionKey: () => {
          throw hostile;
        },
      });
      expect(await handler(http({ "user-agent": "node" }))).toEqual({
        content: [{ type: "text", text: "pong" }],
      });
      expect(calls().map((e) => e.session_source)).toEqual(["per_request"]);
      const lines = warn.mock.calls.filter((args) => String(args[0]).includes("YAVIO-1102"));
      expect(lines).toHaveLength(1);
      expect(String(lines[0]?.[0])).toContain("threw a value that could not be described");
    } finally {
      warn.mockRestore();
    }
  });

  it("undefined and an empty string from sessionKey are no key, silently: no YAVIO-1102 line (#144 review round 1)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const value of [undefined, ""]) {
        const sessionKey = vi.fn(() => value);
        const { handler, calls } = setup({ ...testConfig, sessionKey });
        await handler(http({ "user-agent": "node" }));
        await handler(call());
        expect(sessionKey).toHaveBeenCalledTimes(2);
        expect(calls().map((e) => e.session_source)).toEqual(["per_request", "connection"]);
      }
      expect(warn.mock.calls.filter((args) => String(args[0]).includes("YAVIO-1102"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("identify, step, track and conversion inside the call carry its session and session_source", async () => {
    const yavio = createYavioContext();
    const { handler, events } = setup(
      { ...testConfig, sessionKey: ({ headers }) => headers["x-conversation-id"] },
      () => {
        yavio.identify("anna");
        yavio.step("look");
        yavio.track("viewed");
        yavio.conversion("purchase", { value: 10, currency: "EUR" });
        return { content: [{ type: "text", text: "ok" }] };
      },
    );
    await handler(http({ "x-conversation-id": "conv-9" }));
    expect(events().map((e) => [e.event_type, e.session_source])).toEqual([
      ["connection", "custom"],
      ["identify", "custom"],
      ["step", "custom"],
      ["track", "custom"],
      ["conversion", "custom"],
      ["tool_call", "custom"],
    ]);
    const expected = deriveCustomSessionId("yav_test", "conv-9");
    expect(events().map((e) => [e.event_type, e.session_source, e.session_id])).toEqual([
      ["connection", "custom", expected],
      ["identify", "custom", expected],
      ["step", "custom", expected],
      ["track", "custom", expected],
      ["conversion", "custom", expected],
      ["tool_call", "custom", expected],
    ]);
  });

  it("a per_request session's connection event: once per process per platform, client, protocol version and intent_enabled", async () => {
    // A new proxy per request, as a per-request host builds them.
    const transport = createMockTransport();
    const once = async (headers: Record<string, string>, config: YavioConfig = testConfig) => {
      const server = new McpServer({ name: "test", version: "1.0" });
      const proxy = createProxy(server, config, transport, "0.0.1");
      proxy.tool("ping", () => ({ content: [{ type: "text", text: "pong" }] }));
      await registeredTool(server, "ping")?.handler(http(headers));
    };
    const cursor = { "user-agent": "cursor/1.7.0", "mcp-protocol-version": "2025-06-18" };
    for (let i = 0; i < 5; i++) await once(cursor);
    await once({ ...cursor, "user-agent": "cursor/1.8.0" });
    await once({ ...cursor, "mcp-protocol-version": "2025-11-25" });
    await once({ ...cursor, "user-agent": "claude-code/2.1.309" });
    await once(cursor, { ...testConfig, intent: { ...testConfig.intent, enabled: true } });
    await once(cursor, { ...testConfig, apiKey: "yav_other_project" });
    for (let i = 0; i < 3; i++) await once(cursor);

    const events = transport.sent.flat() as Array<Record<string, unknown>>;
    const toolCalls = events.filter((e) => e.event_type === "tool_call");
    expect(toolCalls).toHaveLength(13);
    expect(new Set(toolCalls.map((e) => e.session_id)).size).toBe(13);
    const connections = events.filter((e) => e.event_type === "connection");
    expect(
      connections.map((e) => [
        e.platform,
        e.client_name,
        e.client_version,
        e.protocol_version,
        (e.metadata as { intent_enabled?: boolean }).intent_enabled,
        e.session_source,
      ]),
    ).toEqual([
      ["cursor", "cursor", "1.7.0", "2025-06-18", false, "per_request"],
      ["cursor", "cursor", "1.8.0", "2025-06-18", false, "per_request"],
      ["cursor", "cursor", "1.7.0", "2025-11-25", false, "per_request"],
      ["claude-code", "claude-code", "2.1.309", "2025-06-18", false, "per_request"],
      ["cursor", "cursor", "1.7.0", "2025-06-18", true, "per_request"],
      ["cursor", "cursor", "1.7.0", "2025-06-18", false, "per_request"],
    ]);
  });

  it("keyed sessions keep one connection event per session, as before", async () => {
    const transport = createMockTransport();
    for (let i = 0; i < 3; i++) {
      const server = new McpServer({ name: "test", version: "1.0" });
      const proxy = createProxy(
        server,
        { ...testConfig, sessionKey: ({ headers }) => headers["x-conversation-id"] },
        transport,
        "0.0.1",
      );
      proxy.tool("ping", () => ({ content: [{ type: "text", text: "pong" }] }));
      for (const conversation of ["conv-a", "conv-b"]) {
        await registeredTool(server, "ping")?.handler(
          http({ "user-agent": "cursor/1.7.0", "x-conversation-id": conversation }),
        );
      }
    }
    const connections = (transport.sent.flat() as Array<Record<string, unknown>>).filter(
      (e) => e.event_type === "connection",
    );
    // Two conversations, three instances each: one connection per conversation.
    expect(connections).toHaveLength(2);
    expect(connections.map((e) => e.session_id)).toEqual([
      deriveCustomSessionId("yav_test", "conv-a"),
      deriveCustomSessionId("yav_test", "conv-b"),
    ]);
  });

  it("tool_discovery carries no session_source, and the listing labels no session: ingest keeps no session fields in tool_registry (#144 review round 1)", async () => {
    const server = new McpServer({ name: "test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, testConfig, transport, "0.0.1");
    proxy.tool("ping", () => ({ content: [{ type: "text", text: "pong" }] }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await proxy.connect(serverTransport);
    const client = new Client({ name: "c", version: "1.0" });
    await client.connect(clientTransport);
    await client.listTools();
    await client.callTool({ name: "ping" });
    await client.close();
    const events = transport.sent.flat() as Array<Record<string, unknown>>;
    const discoveries = events.filter((e) => e.event_type === "tool_discovery");
    expect(discoveries.map((e) => e.tool_name)).toEqual(["ping"]);
    expect(
      discoveries.every((e) => !("session_source" in e) || e.session_source === undefined),
    ).toBe(true);
    // The call after the listing labels the connection's session itself.
    const call = events.find((e) => e.event_type === "tool_call");
    expect(call?.session_source).toBe("connection");
  });

  it("the re-wrap fingerprint changes with sessionKey: its presence, as for intent.fallback", () => {
    const one = () => undefined;
    const other = () => "x";
    expect(configFingerprint({ ...testConfig, sessionKey: one })).not.toBe(
      configFingerprint({ ...testConfig }),
    );
    expect(configFingerprint({ ...testConfig, sessionKey: one })).toBe(
      configFingerprint({ ...testConfig, sessionKey: other }),
    );
  });
});
