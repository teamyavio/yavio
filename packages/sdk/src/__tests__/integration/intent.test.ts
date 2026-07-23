import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as McpServerCtor } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BaseEvent, ToolCallEvent } from "@yavio/shared/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_INTENT_DESCRIPTION, resolveConfig } from "../../core/config.js";
import type { IntentConfig, YavioConfig } from "../../core/types.js";
import { MAX_INTENT_LENGTH } from "../../server/intent.js";
import { _resetGlobalState, createProxy } from "../../server/proxy.js";
import type { Transport } from "../../transport/types.js";

function createMockTransport(): Transport & { sent: BaseEvent[][] } {
  const sent: BaseEvent[][] = [];
  return {
    sent,
    send(events: BaseEvent[]) {
      sent.push(events);
    },
    flush: async () => {},
    shutdown: async () => {},
  };
}

const INTENT_ON: IntentConfig = {
  enabled: true,
  required: true,
  description: "why this tool is called",
};

function makeConfig(intent: IntentConfig): YavioConfig {
  return {
    apiKey: "yav_test",
    endpoint: "http://localhost:9/v1/events",
    capture: { inputValues: true, outputValues: true, geo: true, tokens: true, retries: true },
    // serverOnly skips widget-token minting so no network calls happen
    serverOnly: true,
    intent,
  };
}

interface Harness {
  client: Client;
  events: BaseEvent[][];
  proxy: McpServer;
}

async function connect(proxy: McpServer, events: BaseEvent[][]): Promise<Harness> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await proxy.connect(serverTransport);
  const client = new Client({ name: "intent-test-client", version: "1.0" });
  await client.connect(clientTransport);
  return { client, events, proxy };
}

async function setup(intent: IntentConfig, register: (proxy: McpServer) => void): Promise<Harness> {
  const server = new McpServerCtor({ name: "intent-test", version: "1.0" });
  const transport = createMockTransport();
  const proxy = createProxy(server, makeConfig(intent), transport, "0.2.0");
  register(proxy);
  return connect(proxy, transport.sent);
}

function toolCallEvents(events: BaseEvent[][]): ToolCallEvent[] {
  return events.flat().filter((e): e is ToolCallEvent => e.event_type === "tool_call");
}

function listedTool(result: Awaited<ReturnType<Client["listTools"]>>, name: string) {
  const tool = result.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not advertised`);
  return tool;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

describe("intent capture — disabled (default)", () => {
  beforeEach(() => _resetGlobalState());

  it("does not advertise context and passes arguments through untouched", async () => {
    let seenArgs: unknown;
    const h = await setup({ enabled: false, required: true, description: "d" }, (proxy) => {
      proxy.registerTool(
        "search",
        { inputSchema: { query: z.string() } },
        async (args: { query: string }) => {
          seenArgs = args;
          return ok("done");
        },
      );
    });

    const list = await h.client.listTools();
    expect(listedTool(list, "search").inputSchema.properties).not.toHaveProperty("context");

    await h.client.callTool({ name: "search", arguments: { query: "boots" } });
    expect(seenArgs).toEqual({ query: "boots" });
    expect(toolCallEvents(h.events)[0]?.intent_signals).toBeUndefined();
  });
});

describe("intent capture — enabled", () => {
  beforeEach(() => _resetGlobalState());

  it("advertises a required context parameter with the configured description", async () => {
    const h = await setup(INTENT_ON, (proxy) => {
      proxy.registerTool("search", { inputSchema: { query: z.string() } }, async () => ok("x"));
    });

    const tool = listedTool(await h.client.listTools(), "search");
    const props = tool.inputSchema.properties as Record<string, { description?: string }>;
    expect(props.context).toEqual({ type: "string", description: "why this tool is called" });
    expect(tool.inputSchema.required).toContain("context");
    expect(tool.inputSchema.required).toContain("query");
  });

  it("captures intent and strips context before the handler runs", async () => {
    let seenArgs: unknown;
    const h = await setup(INTENT_ON, (proxy) => {
      proxy.registerTool(
        "search",
        { inputSchema: { query: z.string() } },
        async (args: { query: string }) => {
          seenArgs = args;
          return ok("done");
        },
      );
    });
    await h.client.listTools();

    const result = await h.client.callTool({
      name: "search",
      arguments: { query: "boots", context: "Searching the catalog for hiking boots." },
    });

    expect(result.isError).toBeFalsy();
    expect(seenArgs).toEqual({ query: "boots" });
    const event = toolCallEvents(h.events)[0];
    expect(event?.intent_signals).toEqual({
      intent: "Searching the catalog for hiking boots.",
      source: "context_parameter",
    });
    // The stripped context must not leak into input capture
    expect(event?.input_values).not.toHaveProperty("context");
    expect(event?.input_keys).not.toHaveProperty("context");
  });

  it("never fails a call that omits context (tolerant server)", async () => {
    const h = await setup(INTENT_ON, (proxy) => {
      proxy.registerTool("search", { inputSchema: { query: z.string() } }, async () => ok("x"));
    });
    await h.client.listTools();

    const result = await h.client.callTool({ name: "search", arguments: { query: "boots" } });
    expect(result.isError).toBeFalsy();
    expect(toolCallEvents(h.events)[0]?.intent_signals).toBeUndefined();
  });

  it("strips context before validation so strict schemas still accept the call", async () => {
    let seenArgs: unknown;
    const h = await setup(INTENT_ON, (proxy) => {
      proxy.registerTool(
        "strict_tool",
        // Runtime accepts a full strict Zod object; the raw-shape cast only
        // satisfies the registerTool typings.
        { inputSchema: z.strictObject({ q: z.string() }) as unknown as { q: z.ZodString } },
        async (args: { q: string }) => {
          seenArgs = args;
          return ok("done");
        },
      );
    });
    await h.client.listTools();

    const result = await h.client.callTool({
      name: "strict_tool",
      arguments: { q: "x", context: "Testing strict schema tolerance for the user." },
    });

    expect(result.isError).toBeFalsy();
    expect(seenArgs).toEqual({ q: "x" });
    expect(toolCallEvents(h.events)[0]?.intent_signals?.intent).toBe(
      "Testing strict schema tolerance for the user.",
    );
  });

  it("captures intent for schema-less tools", async () => {
    const h = await setup(INTENT_ON, (proxy) => {
      proxy.tool("ping", async () => ok("pong"));
    });

    const tool = listedTool(await h.client.listTools(), "ping");
    expect((tool.inputSchema.properties as Record<string, unknown>).context).toBeDefined();

    const result = await h.client.callTool({
      name: "ping",
      arguments: { context: "Checking service health before running the user's report." },
    });
    expect(result.isError).toBeFalsy();
    expect(toolCallEvents(h.events)[0]?.intent_signals?.intent).toBe(
      "Checking service health before running the user's report.",
    );
  });

  it("leaves tools with their own context parameter completely untouched", async () => {
    let seenArgs: unknown;
    const h = await setup(INTENT_ON, (proxy) => {
      proxy.registerTool(
        "translate",
        { inputSchema: { text: z.string(), context: z.string() } },
        async (args: { text: string; context: string }) => {
          seenArgs = args;
          return ok("done");
        },
      );
    });

    const tool = listedTool(await h.client.listTools(), "translate");
    const props = tool.inputSchema.properties as Record<string, { description?: string }>;
    // The customer's own description, not ours
    expect(props.context?.description).toBeUndefined();

    await h.client.callTool({
      name: "translate",
      arguments: { text: "hallo", context: "informal greeting" },
    });
    // The genuine argument reaches the handler and is never captured as intent
    expect(seenArgs).toEqual({ text: "hallo", context: "informal greeting" });
    expect(toolCallEvents(h.events)[0]?.intent_signals).toBeUndefined();
  });

  it("advertises context as optional when required is false", async () => {
    const h = await setup({ ...INTENT_ON, required: false }, (proxy) => {
      proxy.registerTool("search", { inputSchema: { query: z.string() } }, async () => ok("x"));
    });

    const tool = listedTool(await h.client.listTools(), "search");
    expect((tool.inputSchema.properties as Record<string, unknown>).context).toBeDefined();
    expect(tool.inputSchema.required ?? []).not.toContain("context");
  });

  it("uses the fallback for calls without context, tagged as inferred", async () => {
    const h = await setup(
      {
        ...INTENT_ON,
        fallback: (toolName, args) => `Inferred for ${toolName}: ${JSON.stringify(args)}`,
      },
      (proxy) => {
        proxy.registerTool("search", { inputSchema: { query: z.string() } }, async () => ok("x"));
      },
    );
    await h.client.listTools();

    await h.client.callTool({ name: "search", arguments: { query: "boots" } });
    expect(toolCallEvents(h.events)[0]?.intent_signals).toEqual({
      intent: 'Inferred for search: {"query":"boots"}',
      source: "inferred",
    });
  });

  it("survives a throwing fallback without breaking the call", async () => {
    const h = await setup(
      {
        ...INTENT_ON,
        fallback: () => {
          throw new Error("boom");
        },
      },
      (proxy) => {
        proxy.registerTool("search", { inputSchema: { query: z.string() } }, async () => ok("x"));
      },
    );
    await h.client.listTools();

    const result = await h.client.callTool({ name: "search", arguments: { query: "boots" } });
    expect(result.isError).toBeFalsy();
    expect(toolCallEvents(h.events)[0]?.intent_signals).toBeUndefined();
  });

  it("clamps oversized intent text", async () => {
    const h = await setup(INTENT_ON, (proxy) => {
      proxy.registerTool("search", { inputSchema: { query: z.string() } }, async () => ok("x"));
    });
    await h.client.listTools();

    await h.client.callTool({
      name: "search",
      arguments: { query: "boots", context: "x".repeat(MAX_INTENT_LENGTH + 100) },
    });
    expect(toolCallEvents(h.events)[0]?.intent_signals?.intent).toHaveLength(MAX_INTENT_LENGTH);
  });

  it("attaches intent to error events too", async () => {
    const h = await setup(INTENT_ON, (proxy) => {
      proxy.registerTool("failing", { inputSchema: { q: z.string() } }, async () => {
        throw new Error("kaputt");
      });
    });
    await h.client.listTools();

    await h.client.callTool({
      name: "failing",
      arguments: { q: "x", context: "Attempting the doomed operation for the user." },
    });
    const event = toolCallEvents(h.events)[0];
    expect(event?.status).toBe("error");
    expect(event?.intent_signals?.intent).toBe("Attempting the doomed operation for the user.");
  });

  it("injects into tools registered before withYavio once tools/list runs", async () => {
    const server = new McpServerCtor({ name: "intent-test", version: "1.0" });
    let seenArgs: unknown;
    // Registered on the RAW server — before instrumentation
    server.registerTool(
      "early",
      { inputSchema: { q: z.string() } },
      async (args: { q: string }) => {
        seenArgs = args;
        return ok("done");
      },
    );
    const transport = createMockTransport();
    const proxy = createProxy(server, makeConfig(INTENT_ON), transport, "0.2.0");
    const h = await connect(proxy, transport.sent);

    const tool = listedTool(await h.client.listTools(), "early");
    expect(tool.inputSchema.required).toContain("context");

    const result = await h.client.callTool({
      name: "early",
      arguments: { q: "x", context: "Calling an early-registered tool for the user." },
    });
    expect(result.isError).toBeFalsy();
    expect(seenArgs).toEqual({ q: "x" });
  });

  it("strips for pre-registered strict tools even when tools/call arrives before any tools/list", async () => {
    // Stateless per-request deployments: this instance never serves
    // tools/list, but the client learned the required context param from a
    // sibling instance. Classification must come from install-time seeding.
    const server = new McpServerCtor({ name: "intent-test", version: "1.0" });
    let seenArgs: unknown;
    server.registerTool(
      "early_strict",
      { inputSchema: z.strictObject({ q: z.string() }) as unknown as { q: z.ZodString } },
      async (args: { q: string }) => {
        seenArgs = args;
        return ok("done");
      },
    );
    const transport = createMockTransport();
    const proxy = createProxy(server, makeConfig(INTENT_ON), transport, "0.2.0");
    const h = await connect(proxy, transport.sent);

    // No listTools() on this instance — straight to the call
    const result = await h.client.callTool({
      name: "early_strict",
      arguments: { q: "x", context: "Calling on a fresh stateless instance for the user." },
    });
    expect(result.isError).toBeFalsy();
    expect(seenArgs).toEqual({ q: "x" });
    // No tool_call event: callbacks registered before withYavio() are not
    // instrumented (pre-existing proxy behavior). What matters here is that
    // the advertised-required context did not break the strict schema.
    expect(toolCallEvents(h.events)).toHaveLength(0);
  });

  it("never strips a genuine context argument even without a prior tools/list", async () => {
    let seenArgs: unknown;
    const h = await setup(INTENT_ON, (proxy) => {
      proxy.registerTool(
        "translate",
        { inputSchema: { text: z.string(), context: z.string() } },
        async (args: { text: string; context: string }) => {
          seenArgs = args;
          return ok("done");
        },
      );
    });

    // No listTools() first — registration/live classification must protect alone
    const result = await h.client.callTool({
      name: "translate",
      arguments: { text: "hallo", context: "formal register" },
    });
    expect(result.isError).toBeFalsy();
    expect(seenArgs).toEqual({ text: "hallo", context: "formal register" });
    expect(toolCallEvents(h.events)[0]?.intent_signals).toBeUndefined();
  });

  it("respects a context param added later via RegisteredTool.update()", async () => {
    let seenArgs: unknown;
    let registered: { update?: (u: unknown) => void } | undefined;
    const h = await setup(INTENT_ON, (proxy) => {
      registered = proxy.registerTool(
        "morphing",
        { inputSchema: { text: z.string() } },
        async (args: unknown) => {
          seenArgs = args;
          return ok("done");
        },
      ) as unknown as { update?: (u: unknown) => void };
    });
    await h.client.listTools(); // classifies as eligible (no own context)

    // Customer redefines the tool so context is now a genuine required arg
    registered?.update?.({ paramsSchema: { text: z.string(), context: z.string() } });

    const result = await h.client.callTool({
      name: "morphing",
      arguments: { text: "hallo", context: "formal register" },
    });
    expect(result.isError).toBeFalsy();
    expect(seenArgs).toEqual({ text: "hallo", context: "formal register" });
    expect(toolCallEvents(h.events)[0]?.intent_signals).toBeUndefined();
  });

  it("classifies raw shapes whose keys are named shape or properties correctly", async () => {
    let seenArgs: unknown;
    const h = await setup(INTENT_ON, (proxy) => {
      proxy.registerTool(
        "render",
        { inputSchema: { shape: z.string(), context: z.string() } },
        async (args: unknown) => {
          seenArgs = args;
          return ok("done");
        },
      );
    });

    // No prior listTools — the shapeHasContext check must see the raw-shape
    // context key despite the decoy `shape` key
    const result = await h.client.callTool({
      name: "render",
      arguments: { shape: "circle", context: "red fill" },
    });
    expect(result.isError).toBeFalsy();
    expect(seenArgs).toEqual({ shape: "circle", context: "red fill" });
    expect(toolCallEvents(h.events)[0]?.intent_signals).toBeUndefined();
  });

  it("keeps concurrent calls' intents isolated", async () => {
    const h = await setup(INTENT_ON, (proxy) => {
      proxy.registerTool(
        "slow",
        { inputSchema: { q: z.string(), delayMs: z.number() } },
        async (args: { q: string; delayMs: number }) => {
          await new Promise((resolve) => setTimeout(resolve, args.delayMs));
          return ok(args.q);
        },
      );
    });
    await h.client.listTools();

    await Promise.all([
      h.client.callTool({
        name: "slow",
        arguments: { q: "first", delayMs: 60, context: "Intent for the first call." },
      }),
      h.client.callTool({
        name: "slow",
        arguments: { q: "second", delayMs: 5, context: "Intent for the second call." },
      }),
    ]);

    const events = toolCallEvents(h.events);
    expect(events).toHaveLength(2);
    for (const event of events) {
      const q = (event.input_values as { q?: string } | undefined)?.q;
      expect(event.intent_signals?.intent).toBe(`Intent for the ${q} call.`);
    }
  });

  it("ignores non-string and whitespace context values without breaking the call", async () => {
    for (const context of [42, { nested: true }, "   "]) {
      _resetGlobalState();
      let seenArgs: unknown;
      const h = await setup(INTENT_ON, (proxy) => {
        proxy.registerTool(
          "search",
          { inputSchema: { query: z.string() } },
          async (args: unknown) => {
            seenArgs = args;
            return ok("done");
          },
        );
      });
      await h.client.listTools();

      const result = await h.client.callTool({
        name: "search",
        arguments: { query: "boots", context } as never,
      });
      expect(result.isError).toBeFalsy();
      expect(seenArgs).toEqual({ query: "boots" });
      expect(toolCallEvents(h.events)[0]?.intent_signals).toBeUndefined();
    }
  });

  it("advertises an identical schema across repeated tools/list calls", async () => {
    const h = await setup(INTENT_ON, (proxy) => {
      proxy.registerTool("search", { inputSchema: { query: z.string() } }, async () => ok("x"));
    });

    const first = listedTool(await h.client.listTools(), "search");
    const second = listedTool(await h.client.listTools(), "search");
    expect(second.inputSchema).toEqual(first.inputSchema);
    const required = (second.inputSchema.required ?? []) as string[];
    expect(required.filter((r) => r === "context")).toHaveLength(1);
  });
});

describe("intent capture — connection event beacon", () => {
  beforeEach(() => _resetGlobalState());

  it("reports intent_enabled true when on and false when off", async () => {
    for (const enabled of [true, false]) {
      _resetGlobalState();
      const h = await setup({ ...INTENT_ON, enabled }, (proxy) => {
        proxy.registerTool("t", { inputSchema: { q: z.string() } }, async () => ok("x"));
      });
      await h.client.listTools();
      await h.client.callTool({ name: "t", arguments: { q: "x" } });
      const connection = h.events.flat().find((e) => e.event_type === "connection");
      expect(connection?.metadata).toEqual({ intent_enabled: enabled });
    }
  });
});

describe("intent config resolution", () => {
  it("defaults to disabled", () => {
    expect(resolveConfig({ apiKey: "k" })?.intent).toEqual({
      enabled: false,
      required: true,
      description: DEFAULT_INTENT_DESCRIPTION,
    });
  });

  it("intent: true enables with defaults", () => {
    const intent = resolveConfig({ apiKey: "k", intent: true })?.intent;
    expect(intent?.enabled).toBe(true);
    expect(intent?.required).toBe(true);
    expect(intent?.description).toBe(DEFAULT_INTENT_DESCRIPTION);
  });

  it("object form overrides required and description", () => {
    const fallback = () => "x";
    const intent = resolveConfig({
      apiKey: "k",
      intent: { required: false, description: "custom", fallback },
    })?.intent;
    expect(intent).toEqual({ enabled: true, required: false, description: "custom", fallback });
  });

  it("reads YAVIO_INTENT from the environment", () => {
    vi.stubEnv("YAVIO_INTENT", "true");
    try {
      expect(resolveConfig({ apiKey: "k" })?.intent.enabled).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("code intent: false overrides an enabling environment variable", () => {
    vi.stubEnv("YAVIO_INTENT", "true");
    try {
      expect(resolveConfig({ apiKey: "k", intent: false })?.intent.enabled).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("treats YAVIO_INTENT=0 and =no as disabled", () => {
    for (const value of ["0", "no"]) {
      vi.stubEnv("YAVIO_INTENT", value);
      try {
        expect(resolveConfig({ apiKey: "k" })?.intent.enabled).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });
});
