import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { YavioConfig } from "../../core/types.js";
import { createProxy } from "../../server/proxy.js";
import { HttpTransport } from "../../transport/http.js";

interface ReceivedBatch {
  events: Array<Record<string, unknown>>;
  sdk_version: string;
  sent_at: string;
}

/** Access the internal _registeredTools object on McpServer. */
function getRegisteredTool(
  server: McpServer,
  name: string,
): { handler: (...args: unknown[]) => unknown } | undefined {
  const tools = (server as unknown as Record<string, Record<string, unknown>>)._registeredTools;
  if (!tools || !(name in tools)) return undefined;
  return tools[name] as { handler: (...args: unknown[]) => unknown };
}

describe("End-to-end: proxy → tool call → HTTP transport → mock ingest", () => {
  let mockServer: ReturnType<typeof createServer>;
  let mockUrl: string;
  const receivedBatches: ReceivedBatch[] = [];

  beforeAll(async () => {
    mockServer = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/events") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          try {
            const batch = JSON.parse(body) as ReceivedBatch;
            receivedBatches.push(batch);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ accepted: batch.events.length, rejected: 0 }));
          } catch {
            res.writeHead(400);
            res.end();
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, "127.0.0.1", () => {
        const addr = mockServer.address() as AddressInfo;
        mockUrl = `http://127.0.0.1:${addr.port}/v1/events`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      mockServer.close(() => resolve());
    });
  });

  it("sends tool_call events to the ingest API on tool invocation", async () => {
    const transport = new HttpTransport({
      endpoint: mockUrl,
      apiKey: "yav_test_key",
      sdkVersion: "0.0.1",
    });

    const server = new McpServer({ name: "test-app", version: "1.0" });
    const config: YavioConfig = {
      apiKey: "yav_test_key",
      endpoint: mockUrl,
      capture: { inputValues: true, geo: true, tokens: true, retries: true },
    };
    const proxy = createProxy(server, config, transport, "0.0.1");

    let handlerExecuted = false;
    proxy.tool("search_rooms", { query: { type: "string" } as never }, (args, extra) => {
      handlerExecuted = true;

      const yavioCtx = (extra as Record<string, unknown>).yavio as {
        identify: (id: string, traits?: Record<string, unknown>) => void;
        step: (name: string, meta?: Record<string, unknown>) => void;
        track: (event: string, props?: Record<string, unknown>) => void;
      };
      expect(yavioCtx).toBeDefined();
      expect(typeof yavioCtx.identify).toBe("function");

      yavioCtx.identify("user-42", { plan: "premium" });
      yavioCtx.step("rooms_found", { count: 3 });
      yavioCtx.track("filter_applied", { type: "price" });

      return { content: [{ type: "text" as const, text: "Found 3 rooms" }] };
    });

    const tool = getRegisteredTool(server, "search_rooms");
    expect(tool).toBeDefined();

    const mockExtra = {
      signal: new AbortController().signal,
      sessionId: "test-session",
      requestId: "req-1",
      sendNotification: async () => {},
      sendRequest: async () => ({}),
    };
    await tool?.handler({ query: "beachfront" }, mockExtra);

    // Force flush via shutdown
    await transport.shutdown();

    expect(handlerExecuted).toBe(true);
    expect(receivedBatches.length).toBeGreaterThan(0);

    const allEvents = receivedBatches.flatMap((b) => b.events);

    const eventTypes = allEvents.map((e) => e.event_type);
    expect(eventTypes).toContain("identify");
    expect(eventTypes).toContain("step");
    expect(eventTypes).toContain("track");
    expect(eventTypes).toContain("tool_call");

    // Verify tool_call event
    const toolCall = allEvents.find((e) => e.event_type === "tool_call");
    expect(toolCall).toBeDefined();
    expect(toolCall?.event_name).toBe("search_rooms");
    expect(toolCall?.status).toBe("success");
    expect(toolCall?.latency_ms).toBeTypeOf("number");
    expect(toolCall?.source).toBe("server");
    expect(toolCall?.session_id).toMatch(/^ses_/);
    expect(toolCall?.trace_id).toMatch(/^tr_/);

    // Verify input_keys contains key presence and input_types contains typeof values
    expect(toolCall?.input_keys).toEqual({ query: true });
    expect(toolCall?.input_types).toEqual({ query: "string" });

    // Verify identify event
    const identifyEvent = allEvents.find((e) => e.event_type === "identify");
    expect(identifyEvent?.user_id).toBe("user-42");

    // Verify events after identify have user_id propagated
    const trackEvent = allEvents.find((e) => e.event_type === "track");
    expect(trackEvent?.user_id).toBe("user-42");

    // Verify PII stripping (plan field should be fine, but if PII was in metadata it would be stripped)
    const identifyTraits = identifyEvent?.user_traits as Record<string, unknown> | undefined;
    expect(identifyTraits?.plan).toBe("premium");
  });

  it("handles tool errors gracefully", async () => {
    const initialBatchCount = receivedBatches.length;

    const transport = new HttpTransport({
      endpoint: mockUrl,
      apiKey: "yav_test_key",
      sdkVersion: "0.0.1",
    });

    const server = new McpServer({ name: "test-app", version: "1.0" });
    const config: YavioConfig = {
      apiKey: "yav_test_key",
      endpoint: mockUrl,
      capture: { inputValues: true, geo: true, tokens: true, retries: true },
    };
    const proxy = createProxy(server, config, transport, "0.0.1");

    proxy.tool("failing_tool", () => {
      throw new Error("Something went wrong");
    });

    const tool = getRegisteredTool(server, "failing_tool");
    expect(tool).toBeDefined();

    const mockExtra = {
      signal: new AbortController().signal,
      requestId: "req-2",
      sendNotification: async () => {},
      sendRequest: async () => ({}),
    };

    try {
      await tool?.handler(mockExtra);
    } catch {
      // Expected error
    }

    await transport.shutdown();

    const newBatches = receivedBatches.slice(initialBatchCount);
    expect(newBatches.length).toBeGreaterThan(0);

    const allEvents = newBatches.flatMap((b) => b.events);
    const errorEvent = allEvents.find((e) => e.event_type === "tool_call" && e.status === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.error_message).toBe("Something went wrong");
  });

  it("sends tool_call events via registerTool", async () => {
    const batchCountBefore = receivedBatches.length;

    const transport = new HttpTransport({
      endpoint: mockUrl,
      apiKey: "yav_test_key",
      sdkVersion: "0.0.1",
    });

    const server = new McpServer({ name: "test-app", version: "1.0" });
    const config: YavioConfig = {
      apiKey: "yav_test_key",
      endpoint: mockUrl,
      capture: { inputValues: true, geo: true, tokens: true, retries: true },
    };
    const proxy = createProxy(server, config, transport, "0.0.1");

    let handlerExecuted = false;
    proxy.registerTool(
      "search_hotels",
      {
        description: "Search for hotels",
        inputSchema: { query: { type: "string" } as never },
      },
      (args, extra) => {
        handlerExecuted = true;

        const yavioCtx = (extra as Record<string, unknown>).yavio as {
          identify: (id: string, traits?: Record<string, unknown>) => void;
          step: (name: string, meta?: Record<string, unknown>) => void;
          track: (event: string, props?: Record<string, unknown>) => void;
        };
        expect(yavioCtx).toBeDefined();
        expect(typeof yavioCtx.identify).toBe("function");

        yavioCtx.identify("user-99", { tier: "gold" });
        yavioCtx.step("hotels_found", { count: 5 });
        yavioCtx.track("filter_applied", { type: "location" });

        return { content: [{ type: "text" as const, text: "Found 5 hotels" }] };
      },
    );

    const tool = getRegisteredTool(server, "search_hotels");
    expect(tool).toBeDefined();

    const mockExtra = {
      signal: new AbortController().signal,
      sessionId: "test-session",
      requestId: "req-rt-1",
      sendNotification: async () => {},
      sendRequest: async () => ({}),
    };
    await tool?.handler({ query: "downtown" }, mockExtra);

    await transport.shutdown();

    expect(handlerExecuted).toBe(true);

    const newBatches = receivedBatches.slice(batchCountBefore);
    expect(newBatches.length).toBeGreaterThan(0);

    const allEvents = newBatches.flatMap((b) => b.events);
    const eventTypes = allEvents.map((e) => e.event_type);
    expect(eventTypes).toContain("identify");
    expect(eventTypes).toContain("step");
    expect(eventTypes).toContain("track");
    expect(eventTypes).toContain("tool_call");

    const toolCall = allEvents.find((e) => e.event_type === "tool_call");
    expect(toolCall).toBeDefined();
    expect(toolCall?.event_name).toBe("search_hotels");
    expect(toolCall?.status).toBe("success");
    expect(toolCall?.latency_ms).toBeTypeOf("number");
    expect(toolCall?.input_keys).toEqual({ query: true });
    expect(toolCall?.input_types).toEqual({ query: "string" });

    const identifyEvent = allEvents.find((e) => e.event_type === "identify");
    expect(identifyEvent?.user_id).toBe("user-99");
  });

  it("strips PII from event metadata before sending", async () => {
    const batchCountBefore = receivedBatches.length;

    const transport = new HttpTransport({
      endpoint: mockUrl,
      apiKey: "yav_test_key",
      sdkVersion: "0.0.1",
    });

    const server = new McpServer({ name: "test-app", version: "1.0" });
    const config: YavioConfig = {
      apiKey: "yav_test_key",
      endpoint: mockUrl,
      capture: { inputValues: true, geo: true, tokens: true, retries: true },
    };
    const proxy = createProxy(server, config, transport, "0.0.1");

    proxy.tool("contact_tool", (extra) => {
      const ctx = (extra as Record<string, unknown>).yavio as {
        track: (event: string, props?: Record<string, unknown>) => void;
      };
      ctx.track("contact_submitted", { email: "test@example.com", phone: "555-123-4567" });
      return { content: [{ type: "text" as const, text: "ok" }] };
    });

    const tool = getRegisteredTool(server, "contact_tool");
    const mockExtra = {
      signal: new AbortController().signal,
      requestId: "req-3",
      sendNotification: async () => {},
      sendRequest: async () => ({}),
    };
    await tool?.handler(mockExtra);
    await transport.shutdown();

    const newBatches = receivedBatches.slice(batchCountBefore);
    const allEvents = newBatches.flatMap((b) => b.events);
    const trackEvent = allEvents.find((e) => e.event_type === "track");
    expect(trackEvent).toBeDefined();
    const meta = trackEvent?.metadata as Record<string, unknown>;
    expect(meta.email).toBe("[EMAIL_REDACTED]");
    expect(meta.phone).toBe("[PHONE_REDACTED]");
  });
});
