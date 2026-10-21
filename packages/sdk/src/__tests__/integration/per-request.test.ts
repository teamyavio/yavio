/**
 * Servers created per request (#133): the process-level state behind every
 * wrap is shared per resolved configuration, so wrapping on every request of
 * a stateless host costs no transport, no listener and no session store.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { deriveSessionId } from "../../core/ids.js";
import { createYavio, withYavio, yavio } from "../../server/index.js";
import { _resetGlobalState } from "../../server/proxy.js";
import { _sharedStateCount, beginProcessShutdown, shutdownAllShared } from "../../server/shared.js";
import { HttpTransport } from "../../transport/http.js";
import { type MockIngest, callViaClient, startMockIngest } from "./helpers.js";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

describe("per-request servers share one process-level state", () => {
  let ingest: MockIngest;
  let endpoint: string;

  beforeEach(async () => {
    _resetGlobalState();
    ingest = await startMockIngest();
    endpoint = ingest.endpoint;
  });

  afterEach(async () => {
    _resetGlobalState();
    await ingest.close();
    vi.restoreAllMocks();
  });

  const callOnce = (wrapped: McpServer, meta?: Record<string, unknown>) =>
    callViaClient(wrapped, { _meta: meta });
  const toolCallEvents = () => ingest.ofType("tool_call");

  it("wrapping 1,000 servers creates one transport and at most one signal handler pair, with no MaxListenersExceededWarning", async () => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => {
      warnings.push(warning);
    };
    process.on("warning", onWarning);
    const sigterm = process.listenerCount("SIGTERM");
    const sigint = process.listenerCount("SIGINT");
    const starts = vi.spyOn(HttpTransport.prototype, "start");
    try {
      for (let i = 0; i < 1000; i++) {
        const server = new McpServer({ name: `req-${i}`, version: "1.0" });
        const wrapped = withYavio(server, { apiKey: "yav_many", endpoint, serverOnly: true });
        expect(wrapped).not.toBe(server);
      }
      // Warnings are emitted on a later tick.
      await new Promise((resolve) => setImmediate(resolve));
      expect(_sharedStateCount()).toBe(1);
      expect(starts).toHaveBeenCalledTimes(1);
      expect(process.listenerCount("SIGTERM")).toBe(sigterm + 1);
      expect(process.listenerCount("SIGINT")).toBe(sigint + 1);
      expect(warnings.filter((w) => w.name === "MaxListenersExceededWarning")).toEqual([]);
    } finally {
      process.off("warning", onWarning);
    }
  });

  it("createYavio().wrap() is synchronous and reuses the state withYavio created for the same config", () => {
    const starts = vi.spyOn(HttpTransport.prototype, "start");
    withYavio(new McpServer({ name: "a", version: "1" }), { apiKey: "yav_same", endpoint });
    const client = createYavio({ apiKey: "yav_same", endpoint });
    const server = new McpServer({ name: "b", version: "1" });
    const wrapped = client.wrap(server);
    expect(wrapped).not.toBe(server);
    expect(wrapped).not.toBeInstanceOf(Promise);
    expect(_sharedStateCount()).toBe(1);
    expect(starts).toHaveBeenCalledTimes(1);
  });

  it("delivers events from every instance through one stream, one connection per session, identify() carried across instances", async () => {
    const client = createYavio({ apiKey: "yav_stream", endpoint, serverOnly: true });
    const conversation = { "openai/session": "conv-shared" };

    const serve = async (index: number, handler: () => unknown) => {
      const server = new McpServer({ name: `instance-${index}`, version: "1.0" });
      const wrapped = client.wrap(server);
      wrapped.registerTool("get_price", { inputSchema: { sku: z.string() } }, async () => {
        handler();
        return ok("x");
      });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await wrapped.connect(st);
      const mcpClient = new Client({ name: "c", version: "1.0" });
      await mcpClient.connect(ct);
      await mcpClient.listTools();
      await mcpClient.callTool({
        name: "get_price",
        arguments: { sku: "A1" },
        _meta: conversation,
      });
      await mcpClient.close();
    };

    await serve(1, () => yavio.identify("user-shared"));
    await serve(2, () => yavio.step("second"));
    await serve(3, () => {});

    await client.shutdown();

    const events = ingest.batches.flatMap((b) => b.events);
    const calls = events.filter((e) => e.event_type === "tool_call");
    expect(calls).toHaveLength(3);
    const sessionId = deriveSessionId("conv-shared");
    expect(calls.every((e) => e.session_id === sessionId)).toBe(true);
    // The user identified on instance 1 is on the events of instances 2 and 3.
    expect(calls.map((e) => e.user_id)).toEqual(["user-shared", "user-shared", "user-shared"]);
    expect(events.filter((e) => e.event_type === "connection")).toHaveLength(1);
    expect(events.filter((e) => e.event_type === "tool_discovery")).toHaveLength(1);
    const step = events.find((e) => e.event_type === "step");
    expect(step?.session_id).toBe(sessionId);
    expect(step?.user_id).toBe("user-shared");
    // One stream: every batch carried the same key.
    expect(new Set(ingest.batches.map((b) => b.authorization))).toEqual(
      new Set(["Bearer yav_stream"]),
    );
  });

  it("keeps two API keys apart: two transports, no cross-delivery, each its own discovery and connection", async () => {
    const a = createYavio({ apiKey: "yav_a", endpoint, serverOnly: true });
    const b = createYavio({ apiKey: "yav_b", endpoint, serverOnly: true });
    expect(_sharedStateCount()).toBe(2);

    // The same tool name and the same conversation on both projects: the
    // dedup is per key, so neither project's events are swallowed by the
    // other's.
    const call = async (client: typeof a, marker: string) => {
      const wrapped = client.wrap(new McpServer({ name: "same", version: "1.0" }));
      wrapped.registerTool("get_price", { inputSchema: { q: z.string() } }, async () => ok(marker));
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await wrapped.connect(st);
      const mcpClient = new Client({ name: "c", version: "1.0" });
      await mcpClient.connect(ct);
      await mcpClient.listTools();
      await mcpClient.callTool({
        name: "get_price",
        arguments: { q: "x" },
        _meta: { "openai/session": "conv-both" },
      });
      await mcpClient.close();
    };
    await call(a, "from-a");
    await call(b, "from-b");
    await a.shutdown();
    await b.shutdown();

    const byKey = (key: string, type: string) =>
      ingest.batches
        .filter((batch) => batch.authorization === `Bearer ${key}`)
        .flatMap((batch) => batch.events)
        .filter((e) => e.event_type === type);
    const outputText = (e: Record<string, unknown>) =>
      (e.output_content as { content: Array<{ text: string }> }).content[0]?.text;
    expect(byKey("yav_a", "tool_call").map(outputText)).toEqual(["from-a"]);
    expect(byKey("yav_b", "tool_call").map(outputText)).toEqual(["from-b"]);
    expect(byKey("yav_a", "tool_discovery")).toHaveLength(1);
    expect(byKey("yav_b", "tool_discovery")).toHaveLength(1);
    expect(byKey("yav_a", "connection")).toHaveLength(1);
    expect(byKey("yav_b", "connection")).toHaveLength(1);
    expect(_sharedStateCount()).toBe(0);
  });

  it("mints a widget token per call, bound to that call's trace id (non-serverOnly)", async () => {
    // Ingest binds the JWT's `tid` to the minting call's trace id and rejects
    // a widget batch under any other trace, so a token shared across
    // instances would break every call after the first.
    const client = createYavio({ apiKey: "yav_widget", endpoint, serverOnly: false });
    const seen: Array<{ token: string; traceId: string }> = [];
    for (let i = 0; i < 3; i++) {
      const wrapped = client.wrap(new McpServer({ name: `w-${i}`, version: "1.0" }));
      wrapped.registerTool("show", { inputSchema: { q: z.string() } }, async () => ok("x"));
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await wrapped.connect(st);
      const mcpClient = new Client({ name: "c", version: "1.0" });
      await mcpClient.connect(ct);
      const result = (await mcpClient.callTool({
        name: "show",
        arguments: { q: "x" },
        _meta: { "openai/session": "conv-widget" },
      })) as { _meta?: { yavio?: { token: string; traceId: string } } };
      const widget = result._meta?.yavio;
      expect(widget).toBeDefined();
      if (widget) seen.push(widget);
      await mcpClient.close();
    }
    await client.shutdown();

    expect(ingest.mints).toHaveLength(3);
    expect(new Set(seen.map((w) => w.traceId)).size).toBe(3);
    for (const widget of seen) expect(widget.token).toBe(`tok-${widget.traceId}`);
    // Each token's trace is the trace of the call's own event.
    const traces = ingest.batches
      .flatMap((b) => b.events)
      .filter((e) => e.event_type === "tool_call")
      .map((e) => e.trace_id);
    expect(traces).toEqual(seen.map((w) => w.traceId));
  });

  it("logs the mode lines once per process, not once per wrap", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    for (let i = 0; i < 3; i++) {
      withYavio(new McpServer({ name: "s", version: "1" }), {
        apiKey: "yav_log",
        endpoint,
        serverOnly: true,
        intent: true,
      });
    }
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes("Server-only mode"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("Intent capture enabled"))).toHaveLength(1);
  });

  it("a hanging widget-token endpoint delays the tool result by the mint timeout at most, with one YAVIO-1103 warning", async () => {
    ingest.hangMints = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createYavio({ apiKey: "yav_hang", endpoint, serverOnly: false });
    const wrapped = client.wrap(new McpServer({ name: "w", version: "1.0" }));
    wrapped.registerTool("get_price", { inputSchema: { q: z.string() } }, async () => ok("x"));
    const started = Date.now();
    const first = (await callOnce(wrapped)) as { content: unknown; _meta?: unknown };
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(3_500);
    // Result untouched: the content is there, no _meta.yavio.
    expect(first.content).toEqual([{ type: "text", text: "x" }]);
    expect(first._meta).toBeUndefined();
    await callOnce(wrapped);
    await client.shutdown();
    expect(ingest.mints).toHaveLength(2);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("YAVIO-1103"));
    expect(lines).toHaveLength(1);
    expect(toolCallEvents()).toHaveLength(2);
  }, 10_000);

  it("a wrap after the last holder's shutdown() sends through the fresh transport — also for the existing proxy", async () => {
    const client = createYavio({ apiKey: "yav_again", endpoint, serverOnly: true });
    const raw = new McpServer({ name: "long-lived", version: "1.0" });
    const wrapped = client.wrap(raw);
    wrapped.registerTool("get_price", { inputSchema: { q: z.string() } }, async () => ok("x"));
    await client.shutdown();
    expect(_sharedStateCount()).toBe(0);

    // Re-wrapping the same server returns the existing proxy; its transport
    // must be the one this wrap just started, not the stopped one.
    expect(client.wrap(raw)).toBe(wrapped);
    expect(_sharedStateCount()).toBe(1);
    await callOnce(wrapped, { "openai/session": "conv-again" });
    await client.shutdown();
    expect(toolCallEvents()).toHaveLength(1);

    // The same through withYavio() after the client is gone.
    expect(withYavio(raw, { apiKey: "yav_again", endpoint, serverOnly: true })).toBe(wrapped);
    await callOnce(wrapped, { "openai/session": "conv-again" });
    const again = createYavio({ apiKey: "yav_again", endpoint, serverOnly: true });
    await again.shutdown(); // drains the pinned transport
    expect(toolCallEvents()).toHaveLength(2);
  });

  it("the first wrap wins: another key, endpoint or wrap() after withYavio() warns once (YAVIO-1108) and keeps the existing proxy", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = new McpServer({ name: "shared-raw", version: "1.0" });
    raw.registerTool("get_price", { inputSchema: { q: z.string() } }, async () => ok("x"));
    const first = withYavio(raw, { apiKey: "yav_first", endpoint, serverOnly: true });
    // Another key: the first key's proxy, and a warning.
    expect(createYavio({ apiKey: "yav_second", endpoint, serverOnly: true }).wrap(raw)).toBe(first);
    // Same key, but wrap() would instrument the pre-registered tool where
    // withYavio() did not: still the first proxy, the tool stays untracked.
    const same = createYavio({ apiKey: "yav_first", endpoint, serverOnly: true });
    expect(same.wrap(raw)).toBe(first);
    // Same options again: no warning, the debug line only.
    expect(withYavio(raw, { apiKey: "yav_first", endpoint, serverOnly: true })).toBe(first);
    await callOnce(first);
    await same.shutdown();

    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("YAVIO-1108"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("createYavio().wrap()");
    expect(toolCallEvents()).toEqual([]);
  });

  it("a re-wrap for another key neither pins nor holds a transport for that key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = new McpServer({ name: "other-key", version: "1.0" });
    const first = withYavio(raw, { apiKey: "yav_mine", endpoint, serverOnly: true });
    expect(_sharedStateCount()).toBe(1);
    expect(withYavio(first, { apiKey: "yav_other", endpoint, serverOnly: true })).toBe(first);
    expect(withYavio(raw, { apiKey: "yav_other", endpoint, serverOnly: true })).toBe(first);
    expect(_sharedStateCount()).toBe(1); // still only yav_mine's transport
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("YAVIO-1108"))).toHaveLength(1);
  });

  it("a differing capture override on a re-wrap warns once (YAVIO-1108) and the first wrap's capture keeps applying", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = new McpServer({ name: "pay-raw", version: "1.0" });
    const first = withYavio(raw, { apiKey: "yav_fp", endpoint, serverOnly: true });
    first.registerTool("get_price", { inputSchema: { q: z.string() } }, async () => ok("x"));
    // Same key and endpoint; only a per-tool override differs.
    const again = withYavio(raw, {
      apiKey: "yav_fp",
      endpoint,
      serverOnly: true,
      tools: { get_price: { inputValues: false } },
    });
    expect(again).toBe(first);
    // The same options in another key order: no warning.
    expect(withYavio(raw, { serverOnly: true, endpoint, apiKey: "yav_fp" })).toBe(first);
    await callOnce(first);
    await createYavio({ apiKey: "yav_fp", endpoint, serverOnly: true }).shutdown();

    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("YAVIO-1108"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("withYavio()");
    // First wrap wins: inputs are still captured.
    const [call] = toolCallEvents();
    expect(call?.input_values).toMatchObject({ q: "x" });
  });

  it("shutdown() of a holder that is not the last drains everything it queued, beyond one batch", async () => {
    const a = createYavio({ apiKey: "yav_drain", endpoint, serverOnly: true });
    const b = createYavio({ apiKey: "yav_drain", endpoint, serverOnly: true });
    const wrapped = a.wrap(new McpServer({ name: "busy", version: "1.0" }));
    wrapped.registerTool("get_price", { inputSchema: { q: z.string() } }, async () => {
      for (let i = 0; i < 250; i++) yavio.track("tick", { i });
      return ok("x");
    });
    await callOnce(wrapped);
    await a.shutdown();
    // Delivered before shutdown() resolved: 250 track + 1 tool_call (+ connection).
    const events = ingest.batches.flatMap((batch) => batch.events);
    expect(events.filter((e) => e.event_type === "track")).toHaveLength(250);
    expect(events.filter((e) => e.event_type === "tool_call")).toHaveLength(1);
    expect(_sharedStateCount()).toBe(1);
    await b.shutdown();
    expect(_sharedStateCount()).toBe(0);
  });

  it("after a signal drained everything, re-wrapping clients hold the new transport: one shutdown() does not stop the other", async () => {
    const a = createYavio({ apiKey: "yav_signal", endpoint, serverOnly: true });
    const b = createYavio({ apiKey: "yav_signal", endpoint, serverOnly: true });
    await shutdownAllShared(); // what SIGTERM does
    expect(_sharedStateCount()).toBe(0);

    const viaA = a.wrap(new McpServer({ name: "a", version: "1.0" }));
    const viaB = b.wrap(new McpServer({ name: "b", version: "1.0" }));
    viaA.registerTool("get_price", { inputSchema: { q: z.string() } }, async () => ok("a"));
    viaB.registerTool("get_price", { inputSchema: { q: z.string() } }, async () => ok("b"));
    expect(_sharedStateCount()).toBe(1);
    await callOnce(viaA);
    await a.shutdown();
    // b still holds the new transport.
    expect(_sharedStateCount()).toBe(1);
    await callOnce(viaB);
    await b.shutdown();
    expect(_sharedStateCount()).toBe(0);
    const outputs = toolCallEvents().map(
      (e) => (e.output_content as { content: Array<{ text: string }> }).content[0]?.text,
    );
    expect(outputs).toEqual(["a", "b"]);
  });

  it("after the signal handler ran, requests still served send at once, best effort — new wraps and existing proxies alike", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const client = createYavio({ apiKey: "yav_sigterm", endpoint, serverOnly: true });
    const before = client.wrap(new McpServer({ name: "before", version: "1.0" }));
    before.registerTool("get_price", { inputSchema: { q: z.string() } }, async () => ok("before"));
    await callOnce(before);

    await beginProcessShutdown(); // what SIGTERM does
    expect(_sharedStateCount()).toBe(0);
    const drainedCount = toolCallEvents().length;
    expect(drainedCount).toBe(1);

    // A request that arrives during the graceful-shutdown window.
    const after = client.wrap(new McpServer({ name: "after", version: "1.0" }));
    after.registerTool("get_price", { inputSchema: { q: z.string() } }, async () => ok("after"));
    await callOnce(after);
    // And one on a server wrapped before the signal.
    await callOnce(before);

    // No timer, no shutdown: delivered on their own, promptly.
    const deadline = Date.now() + 2_000;
    while (toolCallEvents().length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const outputs = toolCallEvents().map(
      (e) => (e.output_content as { content: Array<{ text: string }> }).content[0]?.text,
    );
    expect(outputs.sort()).toEqual(["after", "before", "before"]);
    const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("best effort"));
    expect(lines).toHaveLength(1);
  });

  it("never leaves an unhandled rejection when the mint fails under a throwing handler or a non-object result", async () => {
    // The mint endpoint drops the connection: the mint promise fails while
    // nothing awaits it (handler threw / non-object result).
    ingest.hangMints = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const client = createYavio({ apiKey: "yav_unhandled", endpoint, serverOnly: false });
      const wrapped = client.wrap(new McpServer({ name: "w", version: "1.0" }));
      wrapped.registerTool("get_price", { inputSchema: { q: z.string() } }, async () => {
        throw new Error("boom");
      });
      const result = await callOnce(wrapped);
      expect(result.isError).toBe(true);
      ingest.dropConnections(); // fail the pending mint now
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
      await client.shutdown();
      expect(rejections).toEqual([]);
      expect(toolCallEvents().map((e) => e.status)).toEqual(["error"]);
    } finally {
      process.off("unhandledRejection", onRejection);
      warn.mockRestore();
    }
  });

  it("after the signal handler ran, a long-lived withYavio() server that is never wrapped again still delivers", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const server = withYavio(new McpServer({ name: "long-lived", version: "1.0" }), {
      apiKey: "yav_sig_pinned",
      endpoint,
      serverOnly: true,
    });
    server.registerTool("get_price", { inputSchema: { q: z.string() } }, async () => ok("late"));
    await beginProcessShutdown(); // what SIGTERM does
    expect(_sharedStateCount()).toBe(0);

    // No wrap after the signal: the existing proxy's send must create the
    // immediate transport itself.
    await callOnce(server);
    const deadline = Date.now() + 2_000;
    while (toolCallEvents().length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const outputs = toolCallEvents().map(
      (e) => (e.output_content as { content: Array<{ text: string }> }).content[0]?.text,
    );
    expect(outputs).toEqual(["late"]);
    expect(info.mock.calls.filter((c) => String(c[0]).includes("best effort"))).toHaveLength(1);
  });

  describe("a result the MCP SDK rejects on the wire (v1)", () => {
    const malformed = async () => ({ content: "not an array" }) as unknown as { content: [] };
    const expectServerError = async (wrapped: McpServer, drain: () => Promise<void>) => {
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await wrapped.connect(st);
      const mcpClient = new Client({ name: "c", version: "1.0" });
      await mcpClient.connect(ct);
      await expect(
        mcpClient.callTool({ name: "get_price", arguments: { q: "x" } }),
      ).rejects.toThrow(/Invalid tools\/call result/);
      await mcpClient.close();
      await drain();
      const calls = toolCallEvents();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.status).toBe("error");
      expect(calls[0]?.error_category).toBe("server");
      expect(calls[0]?.error_message).toContain("Invalid tools/call result");
    };

    it("tool registered after withYavio() → client error and a server-category event", async () => {
      const wrapped = withYavio(new McpServer({ name: "lazy", version: "1.0" }), {
        apiKey: "yav_wire_with",
        endpoint,
        serverOnly: true,
      });
      wrapped.registerTool("get_price", { inputSchema: { q: z.string() } }, malformed);
      await expectServerError(wrapped, () =>
        createYavio({ apiKey: "yav_wire_with", endpoint, serverOnly: true }).shutdown(),
      );
    });

    it("tool registered after createYavio().wrap() → client error and a server-category event", async () => {
      const client = createYavio({ apiKey: "yav_wire_wrap", endpoint, serverOnly: true });
      const wrapped = client.wrap(new McpServer({ name: "lazy", version: "1.0" }));
      wrapped.registerTool("get_price", { inputSchema: { q: z.string() } }, malformed);
      await expectServerError(wrapped, () => client.shutdown());
    });
  });

  it("shutdown() drains and forgets the state; a later wrap starts afresh", async () => {
    const client = createYavio({ apiKey: "yav_cycle", endpoint, serverOnly: true });
    client.wrap(new McpServer({ name: "s", version: "1" }));
    expect(_sharedStateCount()).toBe(1);
    await client.shutdown();
    expect(_sharedStateCount()).toBe(0);
    const starts = vi.spyOn(HttpTransport.prototype, "start");
    client.wrap(new McpServer({ name: "s2", version: "1" }));
    expect(_sharedStateCount()).toBe(1);
    expect(starts).toHaveBeenCalledTimes(1);
  });

  it("shutdown() of one client does not stop the transport another client with the same key still uses", async () => {
    const first = createYavio({ apiKey: "yav_two", endpoint, serverOnly: true });
    const second = createYavio({ apiKey: "yav_two", endpoint, serverOnly: true });
    expect(_sharedStateCount()).toBe(1);

    const call = async (client: typeof first, marker: string) => {
      const wrapped = client.wrap(new McpServer({ name: marker, version: "1.0" }));
      wrapped.registerTool("get_price", { inputSchema: { q: z.string() } }, async () => ok(marker));
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await wrapped.connect(st);
      const mcpClient = new Client({ name: "c", version: "1.0" });
      await mcpClient.connect(ct);
      await mcpClient.callTool({ name: "get_price", arguments: { q: "x" } });
      await mcpClient.close();
    };

    await call(first, "before");
    await first.shutdown();
    // Flushed, released, but not stopped: the second client still holds it.
    expect(_sharedStateCount()).toBe(1);
    await call(second, "after");
    await second.shutdown();
    expect(_sharedStateCount()).toBe(0);

    const outputs = ingest.batches
      .flatMap((b) => b.events)
      .filter((e) => e.event_type === "tool_call")
      .map((e) => (e.output_content as { content: Array<{ text: string }> }).content[0]?.text);
    expect(outputs).toEqual(["before", "after"]);
  });

  it("never stops a transport withYavio() created: shutdown() of a client sharing it only flushes", async () => {
    withYavio(new McpServer({ name: "w", version: "1" }), {
      apiKey: "yav_pinned",
      endpoint,
      serverOnly: true,
    });
    const client = createYavio({ apiKey: "yav_pinned", endpoint, serverOnly: true });
    expect(_sharedStateCount()).toBe(1);
    const shutdowns = vi.spyOn(HttpTransport.prototype, "shutdown");
    await client.shutdown();
    expect(shutdowns).not.toHaveBeenCalled();
    expect(_sharedStateCount()).toBe(1);
  });

  it("wrapping the same server again returns the existing proxy: one tool_call per call, not one per wrap", async () => {
    const client = createYavio({ apiKey: "yav_rewrap", endpoint, serverOnly: true });
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const server = new McpServer({ name: "long-lived", version: "1.0" });
    const first = client.wrap(server);
    first.registerTool("get_price", { inputSchema: { q: z.string() } }, async () => ok("x"));
    // A host that wraps its one long-lived server on every request.
    for (let i = 0; i < 3; i++) {
      expect(client.wrap(server)).toBe(first);
      expect(withYavio(server, { apiKey: "yav_rewrap", endpoint, serverOnly: true })).toBe(first);
    }
    // Wrapping the proxy itself is the same no-op.
    expect(client.wrap(first)).toBe(first);
    expect(debug.mock.calls.filter((c) => String(c[0]).includes("already wrapped"))).toHaveLength(
      1,
    );

    const [ct, st] = InMemoryTransport.createLinkedPair();
    await first.connect(st);
    const mcpClient = new Client({ name: "c", version: "1.0" });
    await mcpClient.connect(ct);
    await mcpClient.callTool({ name: "get_price", arguments: { q: "x" } });
    await mcpClient.close();
    await client.shutdown();

    const calls = ingest.batches
      .flatMap((b) => b.events)
      .filter((e) => e.event_type === "tool_call");
    expect(calls).toHaveLength(1);
  });

  describe("tools registered before the wrap", () => {
    const buildServer = (onCall: () => void) => {
      const server = new McpServer({ name: "built", version: "1.0" });
      server.registerTool("get_price", { inputSchema: { sku: z.string() } }, async () => {
        onCall();
        return ok("x");
      });
      return server;
    };
    const connectClient = async (wrapped: McpServer) => {
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await wrapped.connect(st);
      const mcpClient = new Client({ name: "c", version: "1.0" });
      await mcpClient.connect(ct);
      return mcpClient;
    };
    const toolCalls = () =>
      ingest.batches.flatMap((b) => b.events).filter((e) => e.event_type === "tool_call");

    it("withYavio() leaves them untracked, as before 0.5.0", async () => {
      let ran = 0;
      const wrapped = withYavio(
        buildServer(() => ran++),
        { apiKey: "yav_pre_with", endpoint, serverOnly: true },
      );
      const mcpClient = await connectClient(wrapped);
      await mcpClient.callTool({ name: "get_price", arguments: { sku: "A1" } });
      await mcpClient.callTool({ name: "get_price", arguments: { sku: 1 } });
      await mcpClient.close();
      await createYavio({ apiKey: "yav_pre_with", endpoint, serverOnly: true }).shutdown();
      expect(ran).toBe(1);
      expect(toolCalls()).toEqual([]);
    });

    it("createYavio().wrap() instruments them: success, schema rejection and unknown tool are counted", async () => {
      const client = createYavio({ apiKey: "yav_pre_wrap", endpoint, serverOnly: true });
      let ran = 0;
      const wrapped = client.wrap(buildServer(() => ran++));
      const mcpClient = await connectClient(wrapped);
      const okResult = await mcpClient.callTool({ name: "get_price", arguments: { sku: "A1" } });
      expect(okResult.isError).toBeFalsy();
      const rejected = await mcpClient.callTool({ name: "get_price", arguments: { sku: 1 } });
      expect(rejected.isError).toBe(true);
      const unknown = await mcpClient.callTool({ name: "nope", arguments: {} });
      expect(unknown.isError).toBe(true);
      await mcpClient.close();
      await client.shutdown();

      expect(ran).toBe(1);
      const calls = toolCalls();
      expect(calls.map((e) => [e.event_name, e.status, e.error_category])).toEqual([
        ["get_price", "success", undefined],
        ["get_price", "error", "validation"],
        ["nope", "error", "validation"],
      ]);
      // The rejected call carries the declared parameter names, not the value.
      expect(calls[1]?.input_keys).toEqual({ sku: true });
      expect(JSON.stringify(calls[1]?.input_values ?? {})).not.toContain("1");
    });
  });
});
