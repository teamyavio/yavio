/**
 * Signal hand-back (#138): the SDK's SIGTERM/SIGINT listeners drain the
 * registry and then step aside. Any listener on a signal replaces Node's
 * default exit, so an app without a handler of its own would otherwise keep
 * running after Ctrl-C or `docker stop` once the SDK had drained.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createYavio, withYavio } from "../../server/index.js";
import { _resetGlobalState } from "../../server/proxy.js";
import { _setSignalReraise, _sharedStateCount } from "../../server/shared.js";
import { type MockIngest, callTool, startMockIngest } from "./helpers.js";

const RESPONSE_DELAY_MS = 150;

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

const ok = async () => ({ content: [{ type: "text" as const, text: "ok" }] });

describe("SIGTERM/SIGINT hand-back (#138)", () => {
  let ingest: MockIngest;
  /** What the SDK re-raised, with the number of tool_call events delivered at that moment. */
  let reraised: Array<{ signal: string; delivered: number }>;
  const deliveredCalls = () => ingest.events.filter((e) => e.event_type === "tool_call").length;
  const eventTypes = () => ingest.events.map((e) => e.event_type);

  /** A server with one tool, wrapped through `withYavio()`, called once (events buffered). */
  async function wrappedAndCalled(apiKey: string): Promise<McpServer> {
    const raw = new McpServer({ name: "app", version: "1.0" });
    withYavio(raw, { apiKey, endpoint: ingest.endpoint, serverOnly: true }).registerTool(
      "get_price",
      { inputSchema: { q: z.string() } },
      ok,
    );
    await callTool(raw, "get_price", { q: "x" });
    return raw;
  }

  beforeEach(async () => {
    _resetGlobalState(); // also restores the real re-raise
    reraised = [];
    _setSignalReraise((signal) => reraised.push({ signal, delivered: deliveredCalls() }));
    ingest = await startMockIngest();
  });

  afterEach(async () => {
    _resetGlobalState();
    await ingest.close();
  });

  it("as the only listener: drains, removes its listeners and re-raises the signal", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      await wrappedAndCalled("yav_sig");
      expect(process.listenerCount("SIGTERM")).toBe(1);
      expect(ingest.events).toHaveLength(0); // still buffered

      process.emit("SIGTERM", "SIGTERM");
      await vi.waitFor(() => expect(reraised).toHaveLength(1), { timeout: 5_000 });

      // Drained first, then handed back: the events were delivered before the re-raise.
      expect(reraised[0]).toEqual({ signal: "SIGTERM", delivered: 1 });
      expect(eventTypes()).toEqual(["connection", "tool_call"]);
      expect(process.listenerCount("SIGTERM")).toBe(0);
      expect(_sharedStateCount()).toBe(0);
    });
  });

  it("the listener is bound to its signal: an emit without the name still hands SIGINT back, not SIGTERM", async () => {
    await withoutOtherListeners("SIGINT", async () => {
      await wrappedAndCalled("yav_sig_noarg");
      process.emit("SIGINT"); // how some harnesses synthesize Ctrl-C
      await vi.waitFor(() => expect(reraised).toHaveLength(1), { timeout: 5_000 });
      expect(reraised[0]).toEqual({ signal: "SIGINT", delivered: 1 });
    });
  });

  it("next to the app's own listener: drains and steps aside, the app keeps control", async () => {
    await withoutOtherListeners("SIGINT", async () => {
      const app = vi.fn();
      process.on("SIGINT", app);
      try {
        const client = createYavio({
          apiKey: "yav_sig_app",
          endpoint: ingest.endpoint,
          serverOnly: true,
        });
        const raw = new McpServer({ name: "app", version: "1.0" });
        client.wrap(raw).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
        await callTool(raw, "get_price", { q: "x" });
        expect(process.listenerCount("SIGINT")).toBe(2);

        process.emit("SIGINT", "SIGINT");
        // The SDK's listener goes away once the drain is done; the app's stays.
        await vi.waitFor(() => expect(process.listenerCount("SIGINT")).toBe(1), { timeout: 5_000 });

        expect(eventTypes()).toEqual(["connection", "tool_call"]);
        expect(app).toHaveBeenCalledTimes(1);
        expect(reraised).toEqual([]);
        expect(process.rawListeners("SIGINT")).toEqual([app]);
      } finally {
        process.off("SIGINT", app);
      }
    });
  });

  it("an app listener registered with once() is not killed mid-shutdown: the decision is taken when the signal arrives", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      // The Node-docs pattern: once(), then an async shutdown that ends in process.exit().
      const app = vi.fn();
      process.once("SIGTERM", app);
      try {
        await wrappedAndCalled("yav_sig_once");
        expect(process.listenerCount("SIGTERM")).toBe(2);

        process.emit("SIGTERM", "SIGTERM");
        // once() removed the app's listener on delivery; after the drain only ours is left to remove.
        await vi.waitFor(() => expect(process.listenerCount("SIGTERM")).toBe(0), {
          timeout: 5_000,
        });
        await new Promise((r) => setTimeout(r, 50));

        expect(app).toHaveBeenCalledTimes(1);
        expect(eventTypes()).toEqual(["connection", "tool_call"]);
        expect(reraised).toEqual([]); // the app's shutdown decides, not a SIGTERM from us
      } finally {
        process.off("SIGTERM", app);
      }
    });
  });

  it("a second signal while draining hands back at once, and only once", async () => {
    await withoutOtherListeners("SIGINT", async () => {
      await wrappedAndCalled("yav_sig_twice");

      process.emit("SIGINT", "SIGINT"); // starts the drain
      process.emit("SIGINT", "SIGINT"); // impatient second Ctrl-C
      // Handed back synchronously, before anything was delivered.
      expect(reraised).toEqual([{ signal: "SIGINT", delivered: 0 }]);
      expect(process.listenerCount("SIGINT")).toBe(0);

      // The drain that was already running still completes, without a second hand-back.
      await vi.waitFor(() => expect(deliveredCalls()).toBe(1), { timeout: 5_000 });
      await new Promise((r) => setTimeout(r, 50));
      expect(reraised).toHaveLength(1);
    });
  });

  it("after a hand-back the SDK starts over: a later wrap installs the listeners again and the next signal drains", async () => {
    await withoutOtherListeners("SIGINT", async () => {
      await wrappedAndCalled("yav_sig_again");
      process.emit("SIGINT", "SIGINT");
      await vi.waitFor(() => expect(reraised).toHaveLength(1), { timeout: 5_000 });
      expect(process.listenerCount("SIGINT")).toBe(0);

      // The process survived (an app listener elsewhere, say) and keeps serving.
      await wrappedAndCalled("yav_sig_again");
      expect(process.listenerCount("SIGINT")).toBe(1);
      process.emit("SIGINT", "SIGINT");
      await vi.waitFor(() => expect(reraised).toHaveLength(2), { timeout: 5_000 });
      // Drained again (2 tool calls delivered in total), not handed back without draining.
      expect(reraised[1]).toEqual({ signal: "SIGINT", delivered: 2 });
    });
  });

  it("the SDK's listeners are installed once per process, not once per wrap", async () => {
    const sigterm = process.listenerCount("SIGTERM");
    for (let i = 0; i < 5; i++) {
      withYavio(new McpServer({ name: `app-${i}`, version: "1.0" }), {
        apiKey: "yav_sig_once_per_process",
        endpoint: ingest.endpoint,
        serverOnly: true,
      });
    }
    expect(process.listenerCount("SIGTERM")).toBe(sigterm + 1);
  });
});

/**
 * `shutdown()` called from the app's own signal handler (#142). The SDK's
 * listener runs first and starts the drain; the app's handler then awaits
 * `shutdown()` and exits. Before 0.5.2 that await resolved at once — the
 * hold it would release was already cleared — and the exit killed the batch
 * in flight. The mock ingest answers late, so "resolved after delivery"
 * means after the response, not after the request went out.
 */
describe("shutdown() during the signal drain (#142)", () => {
  let ingest: MockIngest;
  const toolCalls = () => ingest.ofType("tool_call");
  /** Every batch received was also answered: nothing is still on its way. */
  const allAnswered = () => ingest.responded === ingest.batches.length && ingest.batches.length > 0;

  function build(apiKey: string, options: { shutdownTimeoutMs?: number } = {}) {
    const client = createYavio({ apiKey, endpoint: ingest.endpoint, serverOnly: true, ...options });
    const raw = new McpServer({ name: "app", version: "1.0" });
    client.wrap(raw).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
    return { client, raw };
  }

  beforeEach(async () => {
    _resetGlobalState();
    _setSignalReraise(() => {});
    ingest = await startMockIngest({ respondAfterMs: RESPONSE_DELAY_MS });
  });

  afterEach(async () => {
    _resetGlobalState();
    await ingest.close();
  });

  it("the README handler: an app listener's await shutdown() resolves only after ingest answered the drained events", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      const { client, raw } = build("yav_142_readme");
      await callTool(raw, "get_price", { q: "x" });
      let answeredOnResolve: boolean | undefined;
      let elapsed = 0;
      const handled = new Promise<void>((resolve) => {
        process.on("SIGTERM", async function app() {
          process.off("SIGTERM", app);
          const started = Date.now();
          await client.shutdown();
          elapsed = Date.now() - started;
          answeredOnResolve = allAnswered();
          resolve();
        });
      });
      process.emit("SIGTERM", "SIGTERM");
      await handled;

      expect(answeredOnResolve).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(RESPONSE_DELAY_MS - 10);
      expect(toolCalls()).toHaveLength(1);
      // #140 unchanged: the SDK stepped aside, the app's listener decided.
      expect(process.listenerCount("SIGTERM")).toBe(0);
      expect(_sharedStateCount()).toBe(0);
    });
  });

  it("a request finishing after the signal, with no wrap, is delivered by a later shutdown()", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      const { client, raw } = build("yav_142_late");
      await callTool(raw, "get_price", { q: "before" });
      process.emit("SIGTERM", "SIGTERM"); // the SDK drains; nothing else listens
      // The in-flight request completes on the proxy wrapped before the
      // signal: its event goes through the key's immediate transport.
      await callTool(raw, "get_price", { q: "after" });
      await client.shutdown();

      expect(allAnswered()).toBe(true);
      expect(toolCalls().map((e) => (e.input_values as { q: string }).q)).toEqual([
        "before",
        "after",
      ]);
    });
  });

  it("a post-signal transport is reused by the next wrap, not orphaned: both calls are delivered", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      const { client, raw } = build("yav_142_reuse");
      await callTool(raw, "get_price", { q: "before" });
      process.emit("SIGTERM", "SIGTERM");
      await vi.waitFor(() => expect(toolCalls()).toHaveLength(1));
      // The old proxy sends first (an immediate transport, its send pending
      // against the slow ingest), then a wrap re-acquires the key.
      await callTool(raw, "get_price", { q: "old-proxy" });
      const next = new McpServer({ name: "next", version: "1.0" });
      client.wrap(next).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
      await callTool(next, "get_price", { q: "new-proxy" });
      await client.shutdown();

      expect(allAnswered()).toBe(true);
      expect(toolCalls().map((e) => (e.input_values as { q: string }).q)).toEqual([
        "before",
        "old-proxy",
        "new-proxy",
      ]);
      expect(_sharedStateCount()).toBe(0);
    });
  });

  it("two concurrent shutdown() calls both resolve after delivery", async () => {
    const { client, raw } = build("yav_142_twice");
    await callTool(raw, "get_price", { q: "x" });
    const started = Date.now();
    const [first, second] = await Promise.all([
      client.shutdown().then(() => ({ at: Date.now() - started, answered: allAnswered() })),
      client.shutdown().then(() => ({ at: Date.now() - started, answered: allAnswered() })),
    ]);
    expect(first.answered).toBe(true);
    expect(second.answered).toBe(true);
    expect(first.at).toBeGreaterThanOrEqual(RESPONSE_DELAY_MS - 10);
    expect(second.at).toBeGreaterThanOrEqual(RESPONSE_DELAY_MS - 10);
    expect(toolCalls()).toHaveLength(1);
  });

  it("a later shutdown() after the first delivered waits for what was sent in between", async () => {
    const { client, raw } = build("yav_142_again");
    await callTool(raw, "get_price", { q: "first" });
    await client.shutdown();
    expect(allAnswered()).toBe(true);
    // The process keeps serving on the existing proxy (no re-wrap): its next
    // event re-acquires nothing — a second shutdown() still delivers it.
    const next = new McpServer({ name: "next", version: "1.0" });
    client.wrap(next).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
    await callTool(next, "get_price", { q: "second" });
    await client.shutdown();
    expect(allAnswered()).toBe(true);
    expect(toolCalls().map((e) => (e.input_values as { q: string }).q)).toEqual([
      "first",
      "second",
    ]);
  });

  it("against an ingest that never answers, shutdown() resolves at shutdownTimeoutMs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      ingest.hangEvents = true;
      const { client, raw } = build("yav_142_hang", { shutdownTimeoutMs: 300 });
      await callTool(raw, "get_price", { q: "x" });
      const started = Date.now();
      await client.shutdown();
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(5_000);
      expect(ingest.batches).toHaveLength(1); // sent, never answered
      expect(ingest.responded).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("withYavio() hosts: a createYavio() client with the same key awaits the signal drain", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      const raw = new McpServer({ name: "app", version: "1.0" });
      withYavio(raw, {
        apiKey: "yav_142_with",
        endpoint: ingest.endpoint,
        serverOnly: true,
      }).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
      await callTool(raw, "get_price", { q: "x" });
      let answeredOnResolve: boolean | undefined;
      const handled = new Promise<void>((resolve) => {
        process.on("SIGTERM", async function app() {
          process.off("SIGTERM", app);
          // The documented recipe: no client of its own, so create one for
          // the same key and endpoint and await its shutdown().
          await createYavio({
            apiKey: "yav_142_with",
            endpoint: ingest.endpoint,
            serverOnly: true,
          }).shutdown();
          answeredOnResolve = allAnswered();
          resolve();
        });
      });
      process.emit("SIGTERM", "SIGTERM");
      await handled;
      expect(answeredOnResolve).toBe(true);
      expect(toolCalls()).toHaveLength(1);
    });
  });
});
