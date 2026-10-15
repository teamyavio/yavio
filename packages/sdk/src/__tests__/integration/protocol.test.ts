import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as McpServerCtor } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { BaseEvent, ToolCallEvent } from "@yavio/shared/events";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod/v3";
import type { IntentConfig, YavioConfig } from "../../core/types.js";
import { createYavioContext } from "../../server/context.js";
import { _resetGlobalState, createProxy } from "../../server/proxy.js";
import type { Transport } from "../../transport/types.js";

/**
 * Status detection at the protocol layer (protocol-layer-status.md, #77):
 * calls McpServer fails BEFORE the tool callback runs — unknown tool,
 * disabled tool, argument validation — and the one it fails AFTER (output
 * validation) must produce exactly one tool_call event each, end to end
 * through a real client and InMemoryTransport.
 */

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

const INTENT_OFF: IntentConfig = { enabled: false, required: true, description: "d" };
const INTENT_ON: IntentConfig = { enabled: true, required: true, description: "why" };

// The tests of the first describe block pin what a rejected call stores when
// its values are kept (rejectedInputValues: true, opt-in since #123); the
// default, false, has its own block at the end.
function makeConfig(overrides: Partial<YavioConfig> = {}): YavioConfig {
  return {
    apiKey: "yav_test",
    endpoint: "http://localhost:9/v1/events",
    capture: {
      inputValues: true,
      outputValues: true,
      geo: true,
      tokens: true,
      retries: true,
      rejectedInputValues: true,
    },
    serverOnly: true,
    intent: INTENT_OFF,
    tools: {},
    ...overrides,
  };
}

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
  const server = new McpServerCtor({ name: "protocol-test", version: "1.0" });
  const transport = createMockTransport();
  const proxy = createProxy(server, makeConfig(overrides), transport, "0.4.0");
  register(proxy, server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await proxy.connect(serverTransport);
  const client = new Client({ name: "protocol-test-client", version: "1.0" });
  await client.connect(clientTransport);
  return { client, events: transport.sent, proxy, server };
}

const toolCalls = (events: BaseEvent[][]): ToolCallEvent[] =>
  events.flat().filter((e): e is ToolCallEvent => e.event_type === "tool_call");

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

const CLIENT_META = {
  "openai/locale": "de-DE",
  "openai/subject": "v1/subject-1",
  "openai/userLocation": { country: "DE", city: "Duisburg" },
};

describe("protocol layer — failures before the handler", () => {
  beforeEach(() => _resetGlobalState());

  it("counts an argument-validation failure as one validation error with the raw arguments", async () => {
    let handlerRan = false;
    const h = await setup((proxy) => {
      proxy.registerTool("search", { inputSchema: { query: z.string() } }, async () => {
        handlerRan = true;
        return ok("x");
      });
    });

    const result = await h.client.callTool({
      name: "search",
      arguments: { query: 42 },
      _meta: CLIENT_META,
    });

    expect(result.isError).toBe(true);
    expect(handlerRan).toBe(false);
    const events = toolCalls(h.events);
    expect(events).toHaveLength(1);
    const event = events[0] as ToolCallEvent;
    expect(event.event_name).toBe("search");
    expect(event.status).toBe("error");
    expect(event.error_category).toBe("validation");
    expect(event.error_message).toContain("Input validation error");
    // The handler never ran: no execution time to report.
    expect(event.latency_ms).toBeUndefined();
    // What did the model send? The raw arguments, under the capture flags.
    expect(event.input_keys).toEqual({ query: true });
    expect(event.input_types).toEqual({ query: "number" });
    expect(event.input_values).toMatchObject({ query: 42 });
    expect(event.locale).toBe("de-DE");
    expect(event.subject_id).toBe("v1/subject-1");
    expect(event.country_code).toBe("DE");
    expect((event.output_content as { isError?: boolean }).isError).toBe(true);
    expect(typeof event.trace_id).toBe("string");
  });

  it.each([
    ["country", "DE", { country: "DE" }],
    [false, undefined, undefined],
  ] as const)(
    "applies capture.geo: %s to the location on a validation event",
    async (geo, countryCode, location) => {
      const h = await setup(
        (proxy) => {
          proxy.registerTool("search", { inputSchema: { query: z.string() } }, async () => ok("x"));
        },
        {
          capture: {
            inputValues: true,
            outputValues: true,
            geo,
            tokens: true,
            retries: true,
            rejectedInputValues: false,
          },
        },
      );

      await h.client.callTool({ name: "search", arguments: { query: 42 }, _meta: CLIENT_META });

      const [event] = toolCalls(h.events);
      expect(event?.error_category).toBe("validation");
      expect(event?.country_code).toBe(countryCode);
      const meta = (event?.input_values as { _meta?: Record<string, unknown> })._meta;
      expect(meta?.["openai/userLocation"]).toEqual(location);
      expect(meta?.["openai/locale"]).toBe("de-DE");
      expect(JSON.stringify(event)).not.toContain("Duisburg");
    },
  );

  it("counts a call to an unknown tool under the name the model asked for", async () => {
    const h = await setup((proxy) => {
      proxy.registerTool("search", { inputSchema: { query: z.string() } }, async () => ok("x"));
    });

    const result = await h.client.callTool({ name: "search_flights", arguments: {} });

    expect(result.isError).toBe(true);
    const events = toolCalls(h.events);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_name).toBe("search_flights");
    expect(events[0]?.status).toBe("error");
    expect(events[0]?.error_category).toBe("validation");
    expect(events[0]?.error_message).toContain("not found");
  });

  it("counts a call to a tool named like an Object property as unknown", async () => {
    const h = await setup((proxy) => {
      proxy.registerTool("search", { inputSchema: { query: z.string() } }, async () => ok("x"));
    });

    const result = await h.client.callTool({ name: "constructor", arguments: {} });

    expect(result.isError).toBe(true);
    const events = toolCalls(h.events);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_name).toBe("constructor");
    expect(events[0]?.error_category).toBe("validation");
  });

  it("leaves a call without a usable tool name untracked", async () => {
    const h = await setup((proxy) => {
      proxy.registerTool("search", { inputSchema: { query: z.string() } }, async () => ok("x"));
    });

    const result = await h.client.callTool({ name: "", arguments: {} });

    expect(result.isError).toBe(true);
    expect(toolCalls(h.events)).toHaveLength(0);
  });

  it("counts a call to a disabled tool", async () => {
    const h = await setup((proxy) => {
      const registered = proxy.registerTool(
        "search",
        { inputSchema: { query: z.string() } },
        async () => ok("x"),
      );
      registered.disable();
    });

    const result = await h.client.callTool({ name: "search", arguments: { query: "boots" } });

    expect(result.isError).toBe(true);
    const events = toolCalls(h.events);
    expect(events).toHaveLength(1);
    expect(events[0]?.error_category).toBe("validation");
    expect(events[0]?.error_message).toContain("disabled");
  });

  it("emits the session's connection event once, even when the first call fails validation", async () => {
    const h = await setup((proxy) => {
      proxy.registerTool("search", { inputSchema: { query: z.string() } }, async () => ok("x"));
    });

    await h.client.callTool({ name: "search", arguments: { query: 42 } });
    await h.client.callTool({ name: "search", arguments: { query: "boots" } });

    const connections = h.events.flat().filter((e) => e.event_type === "connection");
    expect(connections).toHaveLength(1);
    const calls = toolCalls(h.events);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.session_id).toBe(calls[1]?.session_id);
    expect(calls[0]?.trace_id).not.toBe(calls[1]?.trace_id);
  });

  it("still carries the captured intent and no `context` when intent capture is on", async () => {
    const h = await setup(
      (proxy) => {
        proxy.registerTool("search", { inputSchema: { query: z.string() } }, async () => ok("x"));
      },
      { intent: INTENT_ON },
    );
    await h.client.listTools();

    const result = await h.client.callTool({
      name: "search",
      arguments: { query: 42, context: "Finding boots for the user." },
    });

    expect(result.isError).toBe(true);
    const events = toolCalls(h.events);
    expect(events).toHaveLength(1);
    expect(events[0]?.error_category).toBe("validation");
    expect(events[0]?.intent_signals).toEqual({
      intent: "Finding boots for the user.",
      source: "context_parameter",
    });
    expect(events[0]?.input_values).not.toHaveProperty("context");
    expect(events[0]?.input_keys).not.toHaveProperty("context");
  });

  it("honours per-tool overrides on the validation event", async () => {
    const h = await setup(
      (proxy) => {
        proxy.registerTool("book", { inputSchema: { iban: z.string() } }, async () => ok("x"));
        proxy.registerTool("quote", { inputSchema: { zip: z.string() } }, async () => ok("x"));
      },
      { tools: { book: { inputValues: false }, quote: { outputValues: false } } },
    );

    await h.client.callTool({ name: "book", arguments: { iban: 123 }, _meta: CLIENT_META });
    await h.client.callTool({ name: "quote", arguments: { zip: 12345 } });

    const byName = Object.fromEntries(toolCalls(h.events).map((e) => [e.event_name, e]));
    const book = byName.book as ToolCallEvent;
    expect(book.status).toBe("error");
    expect(book.error_category).toBe("validation");
    expect(book.input_values).toBeUndefined();
    expect(book.input_keys).toBeUndefined();
    expect(book.locale).toBeUndefined();
    expect(book.subject_id).toBeUndefined();
    expect(book.country_code).toBeUndefined();
    expect(JSON.stringify(book)).not.toContain("Duisburg");
    // McpServer's validation text echoes the rejected arguments: input.
    expect(book.error_message).toBeUndefined();
    expect(book.output_content).toBeUndefined();

    const quote = byName.quote as ToolCallEvent;
    expect(quote.status).toBe("error");
    expect(quote.error_category).toBe("validation");
    // The validation text is result-derived — output — and can echo input.
    expect(quote.error_message).toBeUndefined();
    expect(quote.output_content).toBeUndefined();
    expect(quote.input_values).toMatchObject({ zip: 12345 });
  });

  it("leaves a tool registered on the unwrapped server untracked, on failure and on success", async () => {
    const h = await setup((proxy, server) => {
      proxy.registerTool("search", { inputSchema: { query: z.string() } }, async () => ok("x"));
      // The escape hatch some integrators still use for sensitive tools.
      server.registerTool("secret", { inputSchema: { iban: z.string() } }, async () => ok("done"));
    });

    const failed = await h.client.callTool({ name: "secret", arguments: { iban: 123 } });
    const succeeded = await h.client.callTool({ name: "secret", arguments: { iban: "DE00" } });

    expect(failed.isError).toBe(true);
    expect(succeeded.isError).toBeFalsy();
    expect(toolCalls(h.events)).toHaveLength(0);
    // Not even the session's connection event: the protocol layer does no
    // session work for a tool it does not track.
    expect(h.events.flat().map((e) => e.event_type)).not.toContain("connection");
    expect(JSON.stringify(h.events)).not.toContain("DE00");
  });

  it("keeps a per-tool override for a tool this deployment never registered", async () => {
    // Conditional registration (feature flag off here), while a client still
    // calls the tool from a schema it cached elsewhere.
    const h = await setup(
      (proxy) => {
        proxy.registerTool("search", { inputSchema: { query: z.string() } }, async () => ok("x"));
      },
      { tools: { book: { inputValues: false } } },
    );

    const result = await h.client.callTool({
      name: "book",
      arguments: { iban: "DE89370400440532013000" },
      _meta: CLIENT_META,
    });

    expect(result.isError).toBe(true);
    const [event] = toolCalls(h.events);
    expect(event?.event_name).toBe("book");
    expect(event?.error_category).toBe("validation");
    expect(event?.input_values).toBeUndefined();
    expect(event?.error_message).toBeUndefined();
    expect(JSON.stringify(h.events)).not.toContain("DE89370400440532013000");
  });

  it("does not count a URL elicitation as a tool failure", async () => {
    const h = await setup((proxy) => {
      proxy.registerTool("pay", { inputSchema: { amount: z.number() } }, async () => {
        throw new McpError(-32042 as never, "Elicitation required", { elicitations: [] });
      });
    });

    const outcome = await h.client.callTool({ name: "pay", arguments: { amount: 1 } }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );

    const events = toolCalls(h.events);
    if ("error" in outcome) {
      // MCP SDK ≥ 1.25 passes the elicitation to the client unwrapped: a
      // protocol flow, not a failure, so nothing is recorded.
      expect(events).toHaveLength(0);
    } else {
      // An older SDK reports it to the client as an isError result; what the
      // client sees is what is counted.
      expect(outcome.result.isError).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]?.status).toBe("error");
    }
  });

  it("gives a second proxy on the same server callback instrumentation, without the protocol layer", async () => {
    // A memoised server wrapped from two modules. The wrappers installed by
    // the first proxy know only its tools; the second proxy must not believe
    // it is covered — it emits discovery at registration and its calls from
    // the callback wrapper, as without the private API.
    const server = new McpServerCtor({ name: "protocol-test", version: "1.0" });
    const first = createMockTransport();
    const second = createMockTransport();
    const proxyA = createProxy(server, makeConfig(), first, "0.4.0");
    const proxyB = createProxy(server, makeConfig(), second, "0.4.0");
    proxyA.registerTool("alpha", { inputSchema: { q: z.string() } }, async () => ok("a"));
    proxyB.registerTool("beta", { inputSchema: { q: z.string() } }, async () => ok("b"));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await proxyA.connect(serverTransport);
    const client = new Client({ name: "protocol-test-client", version: "1.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: "beta", arguments: { q: "x" } });

    expect(result.isError).toBeFalsy();
    const discoveries = second.sent.flat().filter((e) => e.event_type === "tool_discovery");
    expect(discoveries.map((e) => (e as { tool_name?: string }).tool_name)).toEqual(["beta"]);
    expect(toolCalls(second.sent).map((e) => e.event_name)).toEqual(["beta"]);
    expect(toolCalls(first.sent)).toHaveLength(0);
  });

  it("never fails the client's call when opening the call context throws", async () => {
    const sent: BaseEvent[][] = [];
    const transport: Transport = {
      send(events: BaseEvent[]) {
        // The connection event goes out while the call context is opened.
        if (events[0]?.event_type === "connection") throw new Error("transport down");
        sent.push(events);
      },
      flush: async () => {},
      shutdown: async () => {},
    };
    const server = new McpServerCtor({ name: "protocol-test", version: "1.0" });
    const proxy = createProxy(server, makeConfig(), transport, "0.4.0");
    proxy.registerTool("search", { inputSchema: { query: z.string() } }, async () => ok("found"));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await proxy.connect(serverTransport);
    const client = new Client({ name: "protocol-test-client", version: "1.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: "search", arguments: { query: "x" } });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "found" }]);
    const [event] = toolCalls(sent);
    expect(event?.status).toBe("success");
  });
});

describe("protocol layer — one event per call once the handler ran", () => {
  beforeEach(() => _resetGlobalState());

  it("emits exactly one event for a success, with latency, sharing its trace with a conversion", async () => {
    const yavio = createYavioContext();
    const h = await setup((proxy) => {
      proxy.registerTool("book", { inputSchema: { iban: z.string() } }, async () => {
        yavio.conversion("booking_received", { value: 99, currency: "EUR" });
        return ok("booked");
      });
    });

    const result = await h.client.callTool({ name: "book", arguments: { iban: "DE00" } });

    expect(result.isError).toBeFalsy();
    const calls = toolCalls(h.events);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe("success");
    expect(typeof calls[0]?.latency_ms).toBe("number");
    const conversion = h.events.flat().find((e) => e.event_type === "conversion");
    expect(conversion?.trace_id).toBe(calls[0]?.trace_id);
    expect(conversion?.session_id).toBe(calls[0]?.session_id);
  });

  it("emits exactly one event when the handler throws (unknown) or returns isError (tool_error)", async () => {
    const h = await setup((proxy) => {
      proxy.registerTool("throws", { inputSchema: { q: z.string() } }, async () => {
        throw new Error("upstream unavailable");
      });
      proxy.registerTool("fails", { inputSchema: { q: z.string() } }, async () => ({
        isError: true,
        content: [{ type: "text" as const, text: "This offer reference has expired" }],
      }));
    });

    const thrown = await h.client.callTool({ name: "throws", arguments: { q: "x" } });
    const failed = await h.client.callTool({ name: "fails", arguments: { q: "x" } });

    expect(thrown.isError).toBe(true);
    expect(failed.isError).toBe(true);
    const byName = Object.fromEntries(toolCalls(h.events).map((e) => [e.event_name, e]));
    expect(toolCalls(h.events)).toHaveLength(2);
    expect(byName.throws).toMatchObject({
      status: "error",
      error_category: "unknown",
      error_message: "upstream unavailable",
    });
    expect(byName.fails).toMatchObject({
      status: "error",
      error_category: "tool_error",
      error_message: "This offer reference has expired",
    });
    expect(typeof byName.throws?.latency_ms).toBe("number");
  });

  it("corrects the verdict when output validation fails after the handler returned", async () => {
    const h = await setup((proxy) => {
      proxy.registerTool(
        "total",
        {
          inputSchema: { q: z.string() },
          outputSchema: { total: z.number() },
        },
        async () => ({
          content: [{ type: "text" as const, text: "42" }],
          // Violates the tool's own outputSchema — a server bug.
          structuredContent: { total: "forty-two" } as unknown as { total: number },
        }),
      );
    });

    const result = await h.client.callTool({ name: "total", arguments: { q: "x" } });

    expect(result.isError).toBe(true);
    const calls = toolCalls(h.events);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe("error");
    expect(calls[0]?.error_category).toBe("server");
    expect(calls[0]?.error_message).toContain("Output validation error");
    // The handler ran: its latency and its (mismatching) output are kept.
    expect(typeof calls[0]?.latency_ms).toBe("number");
    expect((calls[0]?.output_content as { structuredContent?: unknown }).structuredContent).toEqual(
      { total: "forty-two" },
    );
  });

  it("drops the output-validation message under outputValues: false but keeps the verdict", async () => {
    const h = await setup(
      (proxy) => {
        proxy.registerTool(
          "total",
          { inputSchema: { q: z.string() }, outputSchema: { total: z.number() } },
          async () => ({
            content: [{ type: "text" as const, text: "42" }],
            structuredContent: { total: "forty-two" } as unknown as { total: number },
          }),
        );
      },
      { tools: { total: { outputValues: false } } },
    );

    await h.client.callTool({ name: "total", arguments: { q: "x" } });

    const calls = toolCalls(h.events);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe("error");
    expect(calls[0]?.error_category).toBe("server");
    expect(calls[0]?.error_message).toBeUndefined();
    expect(calls[0]?.output_content).toBeUndefined();
  });

  it("keeps stripping and capturing intent on the normal path after the install refactor", async () => {
    let seenArgs: unknown;
    const h = await setup(
      (proxy) => {
        proxy.registerTool(
          "search",
          { inputSchema: { query: z.string() } },
          async (args: { query: string }) => {
            seenArgs = args;
            return ok("x");
          },
        );
      },
      { intent: INTENT_ON },
    );
    await h.client.listTools();

    await h.client.callTool({
      name: "search",
      arguments: { query: "boots", context: "Finding boots for the user." },
    });

    expect(seenArgs).toEqual({ query: "boots" });
    const calls = toolCalls(h.events);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe("success");
    expect(calls[0]?.intent_signals?.intent).toBe("Finding boots for the user.");
  });
});

describe("rejected calls without rejectedInputValues (the default, #123)", () => {
  beforeEach(() => _resetGlobalState());

  const SECRET = "premium, my wife is pregnant";
  const DEFAULT_CAPTURE = {
    inputValues: true,
    outputValues: true,
    geo: true,
    tokens: true,
    retries: true,
    rejectedInputValues: false,
  } as const;

  /** The rejected value must not appear anywhere in the event. */
  function expectNoValues(event: ToolCallEvent | undefined) {
    expect(event?.status).toBe("error");
    expect(event?.error_category).toBe("validation");
    expect(JSON.stringify(event)).not.toContain("pregnant");
    expect(JSON.stringify(event)).not.toContain("secret note");
    expect(event?.error_message).toBeUndefined();
    expect(event?.output_content).toBeUndefined();
  }

  it.each([
    ["Zod 4", { plan: z.enum(["basic", "premium"]) }],
    // Zod 3's enum error echoes the received value into McpServer's text.
    ["Zod 3", { plan: z3.enum(["basic", "premium"]) }],
  ] as const)(
    "stores names, types, request context and client metadata, but no value (%s)",
    async (_label, inputSchema) => {
      const h = await setup(
        (proxy) => {
          (proxy.registerTool as (...a: unknown[]) => unknown)("pick", { inputSchema }, async () =>
            ok("x"),
          );
        },
        { capture: DEFAULT_CAPTURE },
      );

      await h.client.callTool({
        name: "pick",
        arguments: { plan: SECRET, note: "secret note" },
        _meta: CLIENT_META,
      });

      const [event] = toolCalls(h.events);
      expectNoValues(event);
      // Names and types, including a key the model invented.
      expect(event?.input_keys).toEqual({ plan: true, note: true });
      expect(event?.input_types).toEqual({ plan: "string", note: "string" });
      // input_values carries only the `_`-prefixed request context.
      expect(Object.keys(event?.input_values ?? {})).toEqual(["_meta"]);
      // Client metadata, as on a successful call.
      expect(event?.locale).toBe("de-DE");
      expect(event?.subject_id).toBe("v1/subject-1");
      expect(event?.country_code).toBe("DE");
    },
  );

  it("treats an unknown and a disabled tool like an argument-validation failure", async () => {
    const h = await setup(
      (proxy) => {
        proxy
          .registerTool("search", { inputSchema: { query: z.string() } }, async () => ok("x"))
          .disable();
      },
      { capture: DEFAULT_CAPTURE },
    );

    await h.client.callTool({ name: "search", arguments: { query: SECRET } });
    await h.client.callTool({ name: "search_flights", arguments: { query: SECRET } });

    const events = toolCalls(h.events);
    expect(events.map((e) => e.event_name)).toEqual(["search", "search_flights"]);
    for (const event of events) {
      expectNoValues(event);
      expect(event.input_keys).toEqual({ query: true });
    }
  });

  it("a per-tool override wins over the global flag, in both directions", async () => {
    const h = await setup(
      (proxy) => {
        proxy.registerTool("open", { inputSchema: { plan: z3.enum(["a"]) } }, async () => ok("x"));
        proxy.registerTool("closed", { inputSchema: { plan: z3.enum(["a"]) } }, async () =>
          ok("x"),
        );
      },
      {
        capture: { ...DEFAULT_CAPTURE, rejectedInputValues: true },
        tools: { closed: { rejectedInputValues: false } },
      },
    );
    const h2 = await setup(
      (proxy) => {
        proxy.registerTool("open", { inputSchema: { plan: z3.enum(["a"]) } }, async () => ok("x"));
      },
      { capture: DEFAULT_CAPTURE, tools: { open: { rejectedInputValues: true } } },
    );

    await h.client.callTool({ name: "open", arguments: { plan: SECRET } });
    await h.client.callTool({ name: "closed", arguments: { plan: SECRET } });
    await h2.client.callTool({ name: "open", arguments: { plan: SECRET } });

    const byName = Object.fromEntries(toolCalls(h.events).map((e) => [e.event_name, e]));
    expectNoValues(byName.closed);
    for (const event of [byName.open, toolCalls(h2.events)[0]]) {
      expect(event?.input_values).toMatchObject({ plan: SECRET });
      expect(event?.error_message).toContain("pregnant");
    }
  });

  it("has no effect while inputValues is off: nothing of the input is captured", async () => {
    const h = await setup(
      (proxy) => {
        proxy.registerTool("pick", { inputSchema: { plan: z3.enum(["a"]) } }, async () => ok("x"));
      },
      { capture: { ...DEFAULT_CAPTURE, inputValues: false, rejectedInputValues: true } },
    );

    await h.client.callTool({ name: "pick", arguments: { plan: SECRET }, _meta: CLIENT_META });

    const [event] = toolCalls(h.events);
    expectNoValues(event);
    expect(event?.input_keys).toBeUndefined();
    expect(event?.input_values).toBeUndefined();
    expect(event?.locale).toBeUndefined();
  });

  it("leaves a successful call unchanged: it stores the values the schema accepted", async () => {
    const h = await setup(
      (proxy) => {
        proxy.registerTool(
          "pick",
          { inputSchema: { plan: z.enum(["basic", "premium"]) } },
          async () => ok("x"),
        );
      },
      { capture: DEFAULT_CAPTURE },
    );

    await h.client.callTool({ name: "pick", arguments: { plan: "premium" } });

    const [event] = toolCalls(h.events);
    expect(event?.status).toBe("success");
    expect(event?.input_values).toMatchObject({ plan: "premium" });
  });
});
