/**
 * Signal hand-back (#138): the SDK's SIGTERM/SIGINT listeners drain the
 * registry and then step aside. Any listener on a signal replaces Node's
 * default exit, so an app without a handler of its own would otherwise keep
 * running after Ctrl-C or `docker stop` once the SDK had drained.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createYavio, withYavio } from "../../server/index.js";
import { _resetGlobalState } from "../../server/proxy.js";
import { _setSignalReraise, _sharedStateCount } from "../../server/shared.js";

type Listener = (...args: unknown[]) => void;

/**
 * Run `fn` with every other listener for `signal` detached (vitest has its
 * own), so "the SDK's listener is the only one" is what the test sees; put
 * them back afterwards.
 */
async function withoutOtherListeners(
  signal: NodeJS.Signals,
  fn: () => Promise<void>,
): Promise<void> {
  const others = process.rawListeners(signal) as Listener[];
  for (const l of others) process.off(signal, l);
  try {
    await fn();
  } finally {
    for (const l of others) process.on(signal, l);
  }
}

/** Invoke a tool the way the MCP SDK does, on the raw server behind the proxy. */
async function callOnce(raw: McpServer, name: string): Promise<void> {
  const tools = (raw as unknown as { _registeredTools: Record<string, { handler: Listener }> })
    ._registeredTools;
  await tools[name]?.handler(
    { q: "x" },
    {
      signal: new AbortController().signal,
      requestId: 1,
      sessionId: "s-1",
      sendNotification: async () => {},
      sendRequest: async () => ({}),
    },
  );
}

describe("SIGTERM/SIGINT hand-back (#138)", () => {
  const received: Array<Record<string, unknown>> = [];
  let ingest: ReturnType<typeof createServer>;
  let endpoint: string;
  /** What the SDK re-raised, with the number of tool_call events delivered at that moment. */
  let reraised: Array<{ signal: NodeJS.Signals; delivered: number }>;
  const deliveredCalls = () => received.filter((e) => e.event_type === "tool_call").length;

  beforeEach(async () => {
    _resetGlobalState();
    received.length = 0;
    reraised = [];
    _setSignalReraise((signal) => reraised.push({ signal, delivered: deliveredCalls() }));
    ingest = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        received.push(...(JSON.parse(body) as { events: Array<Record<string, unknown>> }).events);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: 1, rejected: 0 }));
      });
    });
    await new Promise<void>((resolve) => ingest.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(ingest.address() as AddressInfo).port}/v1/events`;
  });

  afterEach(async () => {
    _setSignalReraise(null);
    _resetGlobalState();
    await new Promise<void>((resolve) => ingest.close(() => resolve()));
  });

  it("as the only listener: drains, removes its listeners and re-raises the signal", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      const raw = new McpServer({ name: "app", version: "1.0" });
      const server = withYavio(raw, { apiKey: "yav_sig", endpoint, serverOnly: true });
      server.registerTool("get_price", { inputSchema: { q: z.string() } }, async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }));
      await callOnce(raw, "get_price");
      expect(process.listenerCount("SIGTERM")).toBe(1);
      expect(received).toHaveLength(0); // still buffered

      process.emit("SIGTERM", "SIGTERM");
      await vi.waitFor(() => expect(reraised).toHaveLength(1), { timeout: 5_000 });

      // Drained first, then handed back: the event was delivered before the re-raise.
      expect(reraised[0]).toEqual({ signal: "SIGTERM", delivered: 1 });
      expect(received.map((e) => e.event_type)).toEqual(["connection", "tool_call"]);
      expect(process.listenerCount("SIGTERM")).toBe(0);
      expect(_sharedStateCount()).toBe(0);
    });
  });

  it("next to the app's own listener: drains and steps aside, the app keeps control", async () => {
    await withoutOtherListeners("SIGINT", async () => {
      const app = vi.fn();
      process.on("SIGINT", app);
      try {
        const client = createYavio({ apiKey: "yav_sig_app", endpoint, serverOnly: true });
        const raw = new McpServer({ name: "app", version: "1.0" });
        client
          .wrap(raw)
          .registerTool("get_price", { inputSchema: { q: z.string() } }, async () => ({
            content: [{ type: "text" as const, text: "ok" }],
          }));
        await callOnce(raw, "get_price");
        expect(process.listenerCount("SIGINT")).toBe(2);

        process.emit("SIGINT", "SIGINT");
        // The SDK's listener goes away once the drain is done; the app's stays.
        await vi.waitFor(() => expect(process.listenerCount("SIGINT")).toBe(1), { timeout: 5_000 });

        expect(received.map((e) => e.event_type)).toEqual(["connection", "tool_call"]);
        expect(app).toHaveBeenCalledTimes(1);
        expect(reraised).toEqual([]);
        expect(process.rawListeners("SIGINT")).toEqual([app]);
      } finally {
        process.off("SIGINT", app);
      }
    });
  });

  it("a second signal while draining hands back at once", async () => {
    await withoutOtherListeners("SIGINT", async () => {
      const raw = new McpServer({ name: "app", version: "1.0" });
      withYavio(raw, { apiKey: "yav_sig_twice", endpoint, serverOnly: true }).registerTool(
        "get_price",
        { inputSchema: { q: z.string() } },
        async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      );
      await callOnce(raw, "get_price");

      process.emit("SIGINT", "SIGINT"); // starts the drain
      process.emit("SIGINT", "SIGINT"); // impatient second Ctrl-C
      // Handed back synchronously, before anything was delivered.
      expect(reraised).toEqual([{ signal: "SIGINT", delivered: 0 }]);
      expect(process.listenerCount("SIGINT")).toBe(0);

      // The drain that was already running still completes and hands back once more.
      await vi.waitFor(() => expect(reraised).toHaveLength(2), { timeout: 5_000 });
      expect(reraised[1]).toEqual({ signal: "SIGINT", delivered: 1 });
    });
  });

  it("the SDK's listeners are installed once per process, not once per wrap", async () => {
    const sigterm = process.listenerCount("SIGTERM");
    for (let i = 0; i < 5; i++) {
      withYavio(new McpServer({ name: `app-${i}`, version: "1.0" }), {
        apiKey: "yav_sig_once",
        endpoint,
        serverOnly: true,
      });
    }
    expect(process.listenerCount("SIGTERM")).toBe(sigterm + 1);
  });
});
