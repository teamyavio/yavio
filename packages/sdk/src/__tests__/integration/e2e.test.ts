import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { YavioConfig } from "../../core/types.js";
import { createYavioContext } from "../../server/context.js";
import { _resetGlobalState, createProxy } from "../../server/proxy.js";
import { HttpTransport } from "../../transport/http.js";
import { type MockIngest, callTool, startMockIngest, v1Extra } from "./helpers.js";

describe("End-to-end: proxy → tool call → HTTP transport → mock ingest", () => {
  // One ingest for the whole file: the tests slice its batches by count.
  let ingest: MockIngest;

  beforeAll(async () => {
    ingest = await startMockIngest();
  });

  afterAll(async () => {
    await ingest.close();
  });

  beforeEach(() => {
    _resetGlobalState();
  });

  it("sends tool_call events to the ingest API on tool invocation", async () => {
    const transport = new HttpTransport({
      endpoint: ingest.endpoint,
      apiKey: "yav_test_key",
      sdkVersion: "0.0.1",
    });

    const server = new McpServer({ name: "test-app", version: "1.0" });
    const config: YavioConfig = {
      apiKey: "yav_test_key",
      endpoint: ingest.endpoint,
      capture: {
        inputValues: true,
        outputValues: true,
        geo: true,
        tokens: true,
        retries: true,
        rejectedInputValues: false,
      },
      serverOnly: false,
      intent: { enabled: false, required: true, description: "test" },
      tools: {},
      shutdownTimeoutMs: 10_000,
      shutdownTimeoutMsSource: "default",
    };
    const proxy = createProxy(server, config, transport, "0.0.1");

    const yavioCtx = createYavioContext();
    let handlerExecuted = false;
    proxy.tool("search_rooms", { query: z.string() }, (args) => {
      handlerExecuted = true;

      yavioCtx.identify("user-42", { plan: "premium" });
      yavioCtx.step("rooms_found", { count: 3 });
      yavioCtx.track("filter_applied", { type: "price" });

      return { content: [{ type: "text" as const, text: "Found 3 rooms" }] };
    });

    await callTool(
      server,
      "search_rooms",
      { query: "beachfront" },
      v1Extra({ sessionId: "test-session", requestId: "req-1" }),
    );

    // Force flush via shutdown
    await transport.shutdown();

    expect(handlerExecuted).toBe(true);
    expect(ingest.batches.length).toBeGreaterThan(0);

    const allEvents = ingest.batches.flatMap((b) => b.events);

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
    const initialBatchCount = ingest.batches.length;

    const transport = new HttpTransport({
      endpoint: ingest.endpoint,
      apiKey: "yav_test_key",
      sdkVersion: "0.0.1",
    });

    const server = new McpServer({ name: "test-app", version: "1.0" });
    const config: YavioConfig = {
      apiKey: "yav_test_key",
      endpoint: ingest.endpoint,
      capture: {
        inputValues: true,
        outputValues: true,
        geo: true,
        tokens: true,
        retries: true,
        rejectedInputValues: false,
      },
      serverOnly: false,
      intent: { enabled: false, required: true, description: "test" },
      tools: {},
      shutdownTimeoutMs: 10_000,
      shutdownTimeoutMsSource: "default",
    };
    const proxy = createProxy(server, config, transport, "0.0.1");

    proxy.tool("failing_tool", () => {
      throw new Error("Something went wrong");
    });

    try {
      await callTool(
        server,
        "failing_tool",
        undefined,
        v1Extra({ requestId: "req-2", sessionId: undefined }),
      );
    } catch {
      // Expected error
    }

    await transport.shutdown();

    const newBatches = ingest.batches.slice(initialBatchCount);
    expect(newBatches.length).toBeGreaterThan(0);

    const allEvents = newBatches.flatMap((b) => b.events);
    const errorEvent = allEvents.find((e) => e.event_type === "tool_call" && e.status === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.error_message).toBe("Something went wrong");
  });

  it("sends tool_call events via registerTool", async () => {
    const batchCountBefore = ingest.batches.length;

    const transport = new HttpTransport({
      endpoint: ingest.endpoint,
      apiKey: "yav_test_key",
      sdkVersion: "0.0.1",
    });

    const server = new McpServer({ name: "test-app", version: "1.0" });
    const config: YavioConfig = {
      apiKey: "yav_test_key",
      endpoint: ingest.endpoint,
      capture: {
        inputValues: true,
        outputValues: true,
        geo: true,
        tokens: true,
        retries: true,
        rejectedInputValues: false,
      },
      serverOnly: false,
      intent: { enabled: false, required: true, description: "test" },
      tools: {},
      shutdownTimeoutMs: 10_000,
      shutdownTimeoutMsSource: "default",
    };
    const proxy = createProxy(server, config, transport, "0.0.1");

    const yavioCtx = createYavioContext();
    let handlerExecuted = false;
    proxy.registerTool(
      "search_hotels",
      {
        description: "Search for hotels",
        inputSchema: { query: z.string() },
      },
      (args) => {
        handlerExecuted = true;

        yavioCtx.identify("user-99", { tier: "gold" });
        yavioCtx.step("hotels_found", { count: 5 });
        yavioCtx.track("filter_applied", { type: "location" });

        return { content: [{ type: "text" as const, text: "Found 5 hotels" }] };
      },
    );

    await callTool(
      server,
      "search_hotels",
      { query: "downtown" },
      v1Extra({ sessionId: "test-session", requestId: "req-rt-1" }),
    );

    await transport.shutdown();

    expect(handlerExecuted).toBe(true);

    const newBatches = ingest.batches.slice(batchCountBefore);
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
    const batchCountBefore = ingest.batches.length;

    const transport = new HttpTransport({
      endpoint: ingest.endpoint,
      apiKey: "yav_test_key",
      sdkVersion: "0.0.1",
    });

    const server = new McpServer({ name: "test-app", version: "1.0" });
    const config: YavioConfig = {
      apiKey: "yav_test_key",
      endpoint: ingest.endpoint,
      capture: {
        inputValues: true,
        outputValues: true,
        geo: true,
        tokens: true,
        retries: true,
        rejectedInputValues: false,
      },
      serverOnly: false,
      intent: { enabled: false, required: true, description: "test" },
      tools: {},
      shutdownTimeoutMs: 10_000,
      shutdownTimeoutMsSource: "default",
    };
    const proxy = createProxy(server, config, transport, "0.0.1");

    const yavioCtx = createYavioContext();
    proxy.tool("contact_tool", () => {
      yavioCtx.track("contact_submitted", { email: "test@example.com", phone: "555-123-4567" });
      return { content: [{ type: "text" as const, text: "ok" }] };
    });

    await callTool(
      server,
      "contact_tool",
      undefined,
      v1Extra({ requestId: "req-3", sessionId: undefined }),
    );
    await transport.shutdown();

    const newBatches = ingest.batches.slice(batchCountBefore);
    const allEvents = newBatches.flatMap((b) => b.events);
    const trackEvent = allEvents.find((e) => e.event_type === "track");
    expect(trackEvent).toBeDefined();
    const meta = trackEvent?.metadata as Record<string, unknown>;
    expect(meta.email).toBe("[EMAIL_REDACTED]");
    expect(meta.phone).toBe("[PHONE_REDACTED]");
  });
});
