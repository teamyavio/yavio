/**
 * Servers created per request (#133): the process-level state behind every
 * wrap is shared per resolved configuration, so wrapping on every request of
 * a stateless host costs no transport, no listener and no session store.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { deriveSessionId } from "../../core/ids.js";
import { createYavio, withYavio, yavio } from "../../server/index.js";
import { _resetGlobalState } from "../../server/proxy.js";
import { _sharedStateCount } from "../../server/shared.js";
import { HttpTransport } from "../../transport/http.js";

interface ReceivedBatch {
  authorization: string | undefined;
  events: Array<Record<string, unknown>>;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

describe("per-request servers share one process-level state", () => {
  const received: ReceivedBatch[] = [];
  let mints = 0;
  let ingest: ReturnType<typeof createServer>;
  let endpoint: string;

  beforeEach(async () => {
    _resetGlobalState();
    received.length = 0;
    mints = 0;
    ingest = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        if (req.url === "/v1/widget-tokens") {
          mints++;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              token: "tok",
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            }),
          );
          return;
        }
        received.push({
          authorization: req.headers.authorization,
          events: (JSON.parse(body) as ReceivedBatch).events,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: 1, rejected: 0 }));
      });
    });
    await new Promise<void>((resolve) => {
      ingest.listen(0, "127.0.0.1", () => {
        endpoint = `http://127.0.0.1:${(ingest.address() as AddressInfo).port}/v1/events`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    _resetGlobalState();
    await new Promise<void>((resolve) => ingest.close(() => resolve()));
    vi.restoreAllMocks();
  });

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

    const events = received.flatMap((b) => b.events);
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
    expect(new Set(received.map((b) => b.authorization))).toEqual(new Set(["Bearer yav_stream"]));
  });

  it("keeps two API keys apart: two transports, no cross-delivery", async () => {
    const a = createYavio({ apiKey: "yav_a", endpoint, serverOnly: true });
    const b = createYavio({ apiKey: "yav_b", endpoint, serverOnly: true });
    expect(_sharedStateCount()).toBe(2);

    const call = async (client: typeof a, toolName: string) => {
      const wrapped = client.wrap(new McpServer({ name: toolName, version: "1.0" }));
      wrapped.registerTool(toolName, { inputSchema: { q: z.string() } }, async () => ok("x"));
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await wrapped.connect(st);
      const mcpClient = new Client({ name: "c", version: "1.0" });
      await mcpClient.connect(ct);
      await mcpClient.callTool({ name: toolName, arguments: { q: "x" } });
      await mcpClient.close();
    };
    await call(a, "tool_a");
    await call(b, "tool_b");
    await a.shutdown();
    await b.shutdown();

    const byKey = (key: string) =>
      received
        .filter((batch) => batch.authorization === `Bearer ${key}`)
        .flatMap((batch) => batch.events)
        .filter((e) => e.event_type === "tool_call")
        .map((e) => e.event_name);
    expect(byKey("yav_a")).toEqual(["tool_a"]);
    expect(byKey("yav_b")).toEqual(["tool_b"]);
    expect(_sharedStateCount()).toBe(0);
  });

  it("mints one widget token across instances (non-serverOnly)", async () => {
    const client = createYavio({ apiKey: "yav_widget", endpoint, serverOnly: false });
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
      })) as { _meta?: { yavio?: { token?: string } } };
      expect(result._meta?.yavio?.token).toBe("tok");
      await mcpClient.close();
    }
    await client.shutdown();
    expect(mints).toBe(1);
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
});
