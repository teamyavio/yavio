import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as McpServerCtor } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BaseEvent, ToolCallEvent } from "@yavio/shared/events";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
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

function makeConfig(overrides: Partial<YavioConfig> = {}): YavioConfig {
  return {
    apiKey: "yav_test",
    endpoint: "http://localhost:9/v1/events",
    capture: { inputValues: true, outputValues: true, geo: true, tokens: true, retries: true },
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
    expect(JSON.stringify(h.events)).not.toContain("DE00");
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
