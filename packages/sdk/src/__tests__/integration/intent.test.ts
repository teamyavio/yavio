import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as McpServerCtor } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { BaseEvent, ToolCallEvent } from "@yavio/shared/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_INTENT_DESCRIPTION, resolveConfig } from "../../core/config.js";
import type { IntentConfig, YavioConfig } from "../../core/types.js";
import { MAX_INTENT_LENGTH, createIntentController } from "../../server/intent.js";
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

function makeConfig(intent: IntentConfig, tools: YavioConfig["tools"] = {}): YavioConfig {
  return {
    apiKey: "yav_test",
    endpoint: "http://localhost:9/v1/events",
    capture: { inputValues: true, outputValues: true, geo: true, tokens: true, retries: true },
    // serverOnly skips widget-token minting so no network calls happen
    serverOnly: true,
    intent,
    tools,
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

async function setup(
  intent: IntentConfig,
  register: (proxy: McpServer) => void,
  tools: YavioConfig["tools"] = {},
): Promise<Harness> {
  const server = new McpServerCtor({ name: "intent-test", version: "1.0" });
  const transport = createMockTransport();
  const proxy = createProxy(server, makeConfig(intent, tools), transport, "0.2.0");
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

  // The clamp above uses "x".repeat(), which redaction never touches, so it
  // could not catch either half of the ordering bug this pair covers.
  it("stays within the cap even when redaction expands the text", async () => {
    const h = await setup(INTENT_ON, (proxy) => {
      proxy.registerTool("search", { inputSchema: { query: z.string() } }, async () => ok("x"));
    });
    await h.client.listTools();

    // Every address is 6 chars and redacts to a 16-char token, so clamping
    // before redacting would push the stored value far past the cap.
    await h.client.callTool({
      name: "search",
      arguments: { query: "boots", context: "a@b.co ".repeat(200) },
    });

    const intent = String(toolCallEvents(h.events)[0]?.intent_signals?.intent ?? "");
    expect(intent.length).toBeLessThanOrEqual(MAX_INTENT_LENGTH);
    expect(intent).toContain("[EMAIL_REDACTED]");
    expect(intent).not.toContain("a@b.co");
  });

  it("does not truncate an identifier into an unmatchable fragment", async () => {
    const h = await setup(INTENT_ON, (proxy) => {
      proxy.registerTool("search", { inputSchema: { query: z.string() } }, async () => ok("x"));
    });
    await h.client.listTools();

    // Position an email so the old clamp-then-redact order would slice it at
    // the boundary, leaving "alice@corp." — which matches no pattern and used
    // to ship looking scrubbed while still being linkable.
    const filler = "y".repeat(MAX_INTENT_LENGTH - 8);
    await h.client.callTool({
      name: "search",
      arguments: { query: "boots", context: `${filler}alice@corporate-domain.com tail` },
    });

    const intent = String(toolCallEvents(h.events)[0]?.intent_signals?.intent ?? "");
    expect(intent).not.toContain("alice@");
    expect(intent.length).toBeLessThanOrEqual(MAX_INTENT_LENGTH);
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

  it("never strips context from a wrapped schema whose keys are unreadable", async () => {
    // z.object().refine() stores a ZodEffects: no .shape, no .properties. The
    // customer's `context` is invisible to introspection, so the tool must be
    // left alone rather than have a required argument deleted.
    let seenArgs: unknown;
    const h = await setup(INTENT_ON, (proxy) => {
      proxy.registerTool(
        "translate",
        {
          inputSchema: z
            .object({ text: z.string(), context: z.string() })
            .refine((v) => v.text.length > 0) as unknown as { text: z.ZodString },
        },
        async (args: unknown) => {
          seenArgs = args;
          return ok("done");
        },
      );
    });
    await h.client.listTools();

    const result = await h.client.callTool({
      name: "translate",
      arguments: { text: "hallo", context: "formal register" },
    });
    expect(result.isError).toBeFalsy();
    expect(seenArgs).toEqual({ text: "hallo", context: "formal register" });
  });

  it("never strips context from a schema that accepts unknown keys", async () => {
    let seenArgs: unknown;
    const h = await setup(INTENT_ON, (proxy) => {
      proxy.registerTool(
        "forward",
        {
          inputSchema: z.object({ text: z.string() }).catchall(z.string()) as unknown as {
            text: z.ZodString;
          },
        },
        async (args: unknown) => {
          seenArgs = args;
          return ok("done");
        },
      );
    });
    await h.client.listTools();

    await h.client.callTool({
      name: "forward",
      arguments: { text: "x", context: "GENUINE" },
    });
    expect(seenArgs).toEqual({ text: "x", context: "GENUINE" });
    expect(toolCallEvents(h.events)[0]?.intent_signals).toBeUndefined();
  });

  it("keeps advertising and stripping symmetric for opted-out tools", async () => {
    const h = await setup(INTENT_ON, (proxy) => {
      proxy.registerTool(
        "translate",
        { inputSchema: { text: z.string(), context: z.string() } },
        async () => ok("x"),
      );
      proxy.registerTool("plain", { inputSchema: { q: z.string() } }, async () => ok("x"));
    });

    const list = await h.client.listTools();
    // Opted out: keeps the customer's own context, no injected description
    const translate = listedTool(list, "translate");
    const translateProps = translate.inputSchema.properties as Record<
      string,
      { description?: string }
    >;
    expect(translateProps.context?.description).toBeUndefined();
    // Instrumented: gains the required, described parameter
    const plain = listedTool(list, "plain");
    expect(plain.inputSchema.required).toContain("context");
  });

  it("honours a tools/list opt-out even when the live schema looks eligible", async () => {
    // Gateway pattern: a forwarding tool is registered locally while the real
    // upstream schema — which owns `context` — is served from a custom
    // tools/list. The advertised opt-out must veto the live-schema check, so
    // the value is treated as the customer's argument and never captured.
    const server = new McpServerCtor({ name: "intent-test", version: "1.0" });
    const transport = createMockTransport();
    const proxy = createProxy(server, makeConfig(INTENT_ON), transport, "0.2.0");
    proxy.registerTool("upstream", { inputSchema: { text: z.string() } }, async () => ok("done"));
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "upstream",
          inputSchema: {
            type: "object" as const,
            properties: { text: { type: "string" }, context: { type: "string" } },
            required: ["text", "context"],
          },
        },
      ],
    }));
    const h = await connect(proxy, transport.sent);

    // The advertised schema stays the customer's — no injected description
    const advertised = listedTool(await h.client.listTools(), "upstream");
    const props = advertised.inputSchema.properties as Record<string, { description?: string }>;
    expect(props.context?.description).toBeUndefined();

    await h.client.callTool({
      name: "upstream",
      arguments: { text: "hallo", context: "translation register" },
    });
    // Treated as the customer's argument, so no intent is recorded
    expect(toolCallEvents(h.events)[0]?.intent_signals).toBeUndefined();
  });

  it("survives a malformed tool entry without dropping the tool list", async () => {
    const h = await setup(INTENT_ON, (proxy) => {
      proxy.registerTool("good", { inputSchema: { q: z.string() } }, async () => ok("x"));
      // A hand-written/gateway-forwarded entry whose schema is not shaped as
      // the SDK expects must not take the whole listing down.
      const tools = (proxy as unknown as { _registeredTools: Record<string, unknown> })
        ._registeredTools;
      tools.weird = {
        inputSchema: { type: "object", properties: "all" },
        callback: async () => ok("x"),
      };
    });

    const list = await h.client.listTools();
    expect(list.tools.map((t) => t.name)).toContain("good");
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

  it("treats YAVIO_INTENT=0, =no and =off as disabled", () => {
    for (const value of ["0", "no", "off"]) {
      vi.stubEnv("YAVIO_INTENT", value);
      try {
        expect(resolveConfig({ apiKey: "k" })?.intent.enabled).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });

  it("ignores an empty YAVIO_INTENT instead of treating it as disabled", () => {
    // A container default of "" must not silently override other sources.
    vi.stubEnv("YAVIO_INTENT", "");
    try {
      expect(resolveConfig({ apiKey: "k", intent: true })?.intent.enabled).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("documentation stays in step with the shipped default", () => {
  // The docs quote DEFAULT_INTENT_DESCRIPTION verbatim so readers can see what
  // their models are actually told. That is a second copy of a string, i.e. the
  // same "remember to edit both" drift this SDK just removed for the version
  // constant — so it gets a guard rather than a good intention. Without this, a
  // future wording change silently leaves the published docs quoting a sentence
  // the SDK no longer sends, and a customer greping their tool schemas for it
  // concludes intent capture is broken.
  it("the intent-capture page quotes the current default description", () => {
    const page = readFileSync(
      new URL("../../../../docs/content/docs/02-sdk/07-intent-capture.mdx", import.meta.url),
      "utf-8",
    );
    expect(page).toContain(DEFAULT_INTENT_DESCRIPTION);
  });
});

describe("intent capture — widget-invoked tools", () => {
  // A widget iframe calls its tools with only their real arguments; it cannot
  // know to send `context`. Advertising `context` as REQUIRED on such a tool
  // makes the host refuse every widget call as schema-invalid — and only after
  // it refreshes cached schemas, so the widget breaks silently days later with
  // no server-side trace. Incident: billiger-mietwagen, 2026-08-07 — the
  // widget's 3s auto-refresh dropped from 83 calls/day to zero the moment the
  // connector re-fetched schemas. Hence: on widget-invoked tools `context` is
  // advertised as optional, while capture still applies when a model fills it.
  beforeEach(() => _resetGlobalState());

  const WIDGET_METAS: Array<[string, Record<string, unknown>]> = [
    ["openai/widgetAccessible", { "openai/widgetAccessible": true }],
    ["nested ui.visibility array", { ui: { visibility: ["app"] } }],
    ["flat ui/visibility array", { "ui/visibility": ["app"] }],
    ["bare-string visibility (off-spec authoring slip)", { ui: { visibility: "app" } }],
    [
      "nested resourceUri with omitted visibility (spec default [model, app])",
      { ui: { resourceUri: "ui://views/x.html" } },
    ],
    ["flat ui/resourceUri with omitted visibility", { "ui/resourceUri": "ui://views/x.html" }],
    [
      "nested ui object beside a flat ui/visibility key (shadowing regression)",
      { ui: { resourceUri: "ui://views/x.html" }, "ui/visibility": ["app"] },
    ],
  ];

  /** One registration shape for every widget test, plus a model-tool control. */
  function setupWidget(
    meta: Record<string, unknown>,
    intent: IntentConfig = INTENT_ON,
    onCall?: (args: unknown) => void,
  ): Promise<Harness> {
    return setup(intent, (proxy) => {
      proxy.registerTool(
        "widget-refresh",
        { inputSchema: { search_id: z.string() }, _meta: meta },
        async (args: { search_id: string }) => {
          onCall?.(args);
          return ok("refreshed");
        },
      );
      proxy.registerTool("search", { inputSchema: { query: z.string() } }, async () => ok("x"));
    });
  }

  it.each(WIDGET_METAS)("advertises context as optional: %s", async (_label, meta) => {
    const h = await setupWidget(meta);
    const list = await h.client.listTools();

    const widgetTool = listedTool(list, "widget-refresh");
    expect(widgetTool.inputSchema.properties).toHaveProperty("context");
    expect(widgetTool.inputSchema.required ?? []).not.toContain("context");

    // Control on the same server: ordinary tools keep the required parameter.
    expect(listedTool(list, "search").inputSchema.required).toContain("context");
  });

  it("openai/widgetAccessible: false does not downgrade the tool", async () => {
    // Pins the deliberate strict `=== true` check: an explicit false (or any
    // non-true value) must not count as widget-invoked, and a later cleanup
    // "simplifying" the comparison to truthiness has a failing test to answer.
    const h = await setupWidget({ "openai/widgetAccessible": false });
    const tool = listedTool(await h.client.listTools(), "widget-refresh");
    expect(tool.inputSchema.required).toContain("context");
  });

  it("an explicit visibility of ['model'] keeps context required despite a resourceUri", async () => {
    // The documented escape hatch: an app whose widget never calls its
    // view-owning tool declares model-only visibility and keeps required
    // context (maximum capture) on it.
    const h = await setupWidget({
      ui: { resourceUri: "ui://views/x.html", visibility: ["model"] },
    });
    const tool = listedTool(await h.client.listTools(), "widget-refresh");
    expect(tool.inputSchema.required).toContain("context");
  });

  it("accepts a context-less widget call, records no intent, and skips the fallback", async () => {
    // The fallback exists to approximate intents for model calls that omit
    // context. Widget traffic (a 3s auto-refresh) is context-less by nature —
    // running the fallback there would record machine-generated "inferred"
    // intents at machine frequency.
    const fallback = vi.fn(() => "machine noise");
    let seenArgs: unknown;
    const h = await setupWidget(
      { "openai/widgetAccessible": true },
      { ...INTENT_ON, fallback },
      (args) => {
        seenArgs = args;
      },
    );
    await h.client.listTools();

    const result = await h.client.callTool({
      name: "widget-refresh",
      arguments: { search_id: "abc123" },
    });
    expect(result.isError).toBeFalsy();
    expect(seenArgs).toEqual({ search_id: "abc123" });
    expect(toolCallEvents(h.events)[0]?.intent_signals).toBeUndefined();
    expect(fallback).not.toHaveBeenCalled();

    // The fallback still serves ordinary tools on the same server.
    await h.client.callTool({ name: "search", arguments: { query: "boots" } });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(toolCallEvents(h.events)[1]?.intent_signals).toEqual({
      intent: "machine noise",
      source: "inferred",
    });
  });

  it("still captures and strips context when a model call supplies it", async () => {
    let seenArgs: unknown;
    const h = await setupWidget({ "openai/widgetAccessible": true }, INTENT_ON, (args) => {
      seenArgs = args;
    });
    await h.client.listTools();

    const result = await h.client.callTool({
      name: "widget-refresh",
      arguments: { search_id: "abc123", context: "Fetching offer details the user asked about." },
    });

    expect(result.isError).toBeFalsy();
    expect(seenArgs).toEqual({ search_id: "abc123" });
    const event = toolCallEvents(h.events)[0];
    expect(event?.intent_signals).toEqual({
      intent: "Fetching offer details the user asked about.",
      source: "context_parameter",
    });
    // The stripped context must not leak into input capture — the widget
    // branch must assert no less than the model-tool test above.
    expect(event?.input_values).not.toHaveProperty("context");
    expect(event?.input_keys).not.toHaveProperty("context");
  });
});

describe("intent capture — widget classification without listed _meta", () => {
  // MCP SDK versions before 1.18.0 accept `_meta` in registerTool but drop
  // it: it reaches neither the registry nor the tools/list entries. The
  // registration-time record (noteToolRegistration's meta argument, fed by
  // the proxy's registerTool interceptor) is then the only signal, so the
  // wrapped list handler must classify from it even when the listed entry
  // carries no _meta. Exercised against a stub low-level server because the
  // MCP SDK installed in this repo always forwards _meta.
  beforeEach(() => _resetGlobalState());

  function installOnStub(intent: IntentConfig, listedTools: Array<Record<string, unknown>>) {
    const handlers = new Map<string, (req: unknown, extra: unknown) => Promise<unknown>>();
    handlers.set("tools/list", async () => ({ tools: listedTools }));
    const controller = createIntentController(intent);
    controller.install({
      server: { setRequestHandler: () => {}, _requestHandlers: handlers },
      _registeredTools: {},
    } as unknown as McpServer);
    return { controller, callList: () => handlers.get("tools/list")?.({}, {}) };
  }

  it("classifies from the registration-time _meta when the listed entry carries none", async () => {
    const { controller, callList } = installOnStub(INTENT_ON, [
      {
        name: "widget-refresh",
        inputSchema: { type: "object", properties: { search_id: { type: "string" } } },
      },
      {
        name: "search",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ]);
    controller.noteToolRegistration("widget-refresh", [], { "openai/widgetAccessible": true });
    controller.noteToolRegistration("search", []);

    const result = (await callList()) as {
      tools: Array<{ name: string; inputSchema: { properties: object; required?: string[] } }>;
    };
    const widget = result.tools.find((t) => t.name === "widget-refresh");
    const search = result.tools.find((t) => t.name === "search");
    expect(widget?.inputSchema.properties).toHaveProperty("context");
    expect(widget?.inputSchema.required ?? []).not.toContain("context");
    expect(search?.inputSchema.required).toContain("context");
  });

  it("removes a pre-existing 'context' entry from a widget tool's required array", async () => {
    const { callList } = installOnStub(INTENT_ON, [
      {
        name: "widget-refresh",
        _meta: { "openai/widgetAccessible": true },
        inputSchema: {
          type: "object",
          properties: { search_id: { type: "string" } },
          // Legal JSON Schema: required may name keys that properties omits —
          // e.g. a stale leftover after the property itself was removed. Kept
          // as-is it would defeat the widget exemption silently.
          required: ["search_id", "context"],
        },
      },
    ]);
    const result = (await callList()) as { tools: Array<{ inputSchema: { required?: string[] } }> };
    expect(result.tools[0]?.inputSchema.required).toEqual(["search_id"]);
  });

  it("strips a stale required 'context' on ordinary tools under required: false", async () => {
    // The stale-required cleanup is not widget-specific: with intent
    // configured optional, a leftover required: ["context"] in a customer
    // schema would otherwise ship `context` as required against the
    // operator's explicit configuration — the hard-validating-client
    // breakage `required: false` exists to avoid.
    const { callList } = installOnStub({ ...INTENT_ON, required: false }, [
      {
        name: "search",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query", "context"],
        },
      },
    ]);
    const result = (await callList()) as { tools: Array<{ inputSchema: { required?: string[] } }> };
    expect(result.tools[0]?.inputSchema.required).toEqual(["query"]);
  });
});

describe("intent capture — per-tool intent: false (third state)", () => {
  beforeEach(() => _resetGlobalState());

  const DISABLED = { book: { intent: false } };

  it("never advertises context on the disabled tool while other tools still get it", async () => {
    const h = await setup(
      INTENT_ON,
      (proxy) => {
        proxy.registerTool("book", { inputSchema: { iban: z.string() } }, async () => ok("x"));
        proxy.registerTool("search", { inputSchema: { query: z.string() } }, async () => ok("x"));
      },
      DISABLED,
    );

    const list = await h.client.listTools();
    const book = listedTool(list, "book");
    expect(book.inputSchema.properties).not.toHaveProperty("context");
    expect(book.inputSchema.required ?? []).not.toContain("context");
    expect(listedTool(list, "search").inputSchema.properties).toHaveProperty("context");
  });

  // A host with a cached schema keeps sending `context` after the override
  // lands. On a strict schema the SDK must still remove it — or the whole
  // call is rejected — while capturing nothing.
  it("strips a context the client still sends, without capturing it, on a strict schema", async () => {
    let seenArgs: unknown;
    const h = await setup(
      INTENT_ON,
      (proxy) => {
        proxy.registerTool(
          "book",
          { inputSchema: z.strictObject({ iban: z.string() }) as unknown as { iban: z.ZodString } },
          async (args: { iban: string }) => {
            seenArgs = args;
            return ok("booked");
          },
        );
      },
      DISABLED,
    );
    await h.client.listTools();

    const result = await h.client.callTool({
      name: "book",
      arguments: { iban: "DE00", context: "Booking a contract for Max Mustermann." },
    });

    expect(result.isError).toBeFalsy();
    expect(seenArgs).toEqual({ iban: "DE00" });
    const events = toolCallEvents(h.events);
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("success");
    expect(events[0]?.intent_signals).toBeUndefined();
    expect(JSON.stringify(h.events)).not.toContain("Mustermann");
  });

  it("skips the fallback for the disabled tool but still uses it elsewhere", async () => {
    const fallback = vi.fn((toolName: string) => `Inferred for ${toolName}`);
    const h = await setup(
      { ...INTENT_ON, fallback },
      (proxy) => {
        proxy.registerTool("book", { inputSchema: { iban: z.string() } }, async () => ok("x"));
        proxy.registerTool("search", { inputSchema: { query: z.string() } }, async () => ok("x"));
      },
      DISABLED,
    );
    await h.client.listTools();

    await h.client.callTool({ name: "book", arguments: { iban: "DE00" } });
    await h.client.callTool({ name: "search", arguments: { query: "boots" } });

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith("search", { query: "boots" });
    const byName = Object.fromEntries(toolCallEvents(h.events).map((e) => [e.event_name, e]));
    expect(byName.book?.intent_signals).toBeUndefined();
    expect(byName.search?.intent_signals).toEqual({
      intent: "Inferred for search",
      source: "inferred",
    });
  });

  it("leaves a disabled tool that owns its own context parameter untouched", async () => {
    let seenArgs: unknown;
    const h = await setup(
      INTENT_ON,
      (proxy) => {
        proxy.registerTool(
          "book",
          { inputSchema: { iban: z.string(), context: z.string() } },
          async (args: { iban: string; context: string }) => {
            seenArgs = args;
            return ok("x");
          },
        );
      },
      DISABLED,
    );
    await h.client.listTools();
    await h.client.callTool({
      name: "book",
      arguments: { iban: "DE00", context: "customer note" },
    });
    // The customer's own argument reaches the handler; nothing is captured.
    expect(seenArgs).toEqual({ iban: "DE00", context: "customer note" });
    expect(toolCallEvents(h.events)[0]?.intent_signals).toBeUndefined();
  });
});
