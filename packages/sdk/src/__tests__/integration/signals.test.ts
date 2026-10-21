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
      // The old proxy's batch is answered last: with a fresh transport per
      // wrap (the orphaning bug) it leaves first and would be answered first
      // under a uniform delay, so a uniform delay cannot tell the two apart.
      const q = (batch: { events: Array<Record<string, unknown>> }) =>
        batch.events.map((e) => (e.input_values as { q?: string } | undefined)?.q);
      ingest.respondAfterMs = (batch) => (q(batch).includes("old-proxy") ? 400 : 50);
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
      const atResolve = await client
        .shutdown()
        .then(() => ({ answered: ingest.responded, batches: ingest.batches.length }));

      // Every batch — the old proxy's slow one included — was answered before shutdown() resolved.
      expect(atResolve).toEqual({ answered: 3, batches: 3 });
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

  it("a second shutdown() with no hold and no signal still delivers what the key's transport carries", async () => {
    // A withYavio() host with the recipe's shutdown client, created at
    // startup and never wrapping anything: its first shutdown() releases its
    // hold (the pin keeps the transport); the second has no hold to release
    // and no signal drain to wait for — the settleShared() path — and must
    // still deliver what the pinned proxy sent in between.
    const apiKey = "yav_142_again";
    const analytics = createYavio({ apiKey, endpoint: ingest.endpoint, serverOnly: true });
    const raw = new McpServer({ name: "app", version: "1.0" });
    withYavio(raw, { apiKey, endpoint: ingest.endpoint, serverOnly: true }).registerTool(
      "get_price",
      { inputSchema: { q: z.string() } },
      ok,
    );
    await callTool(raw, "get_price", { q: "first" });
    expect(await analytics.shutdown().then(allAnswered)).toBe(true);
    expect(_sharedStateCount()).toBe(1); // pinned: still live

    await callTool(raw, "get_price", { q: "second" }); // buffered for the 10 s timer
    expect(await analytics.shutdown().then(allAnswered)).toBe(true);
    expect(toolCalls().map((e) => (e.input_values as { q: string }).q)).toEqual([
      "first",
      "second",
    ]);
    expect(process.listenerCount("SIGTERM")).toBeGreaterThan(0); // no signal happened
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
      // The transport is stopped, but its fetch is still waiting: answer it
      // before cleanup closes the socket, or the failed fetch retries into
      // the next test's stderr (YAVIO-1200).
      await ingest.answerHung();
      warn.mockRestore();
    }
  });

  it("two clients, one key: each shutdown() runs under its own shutdownTimeoutMs, not the transport creator's", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      ingest.respondAfterMs = 800;
      // A creates the key's transport with a 300 ms deadline; B holds it too, with 3 s.
      const a = createYavio({
        apiKey: "yav_142_two",
        endpoint: ingest.endpoint,
        serverOnly: true,
        shutdownTimeoutMs: 300,
      });
      const b = createYavio({
        apiKey: "yav_142_two",
        endpoint: ingest.endpoint,
        serverOnly: true,
        shutdownTimeoutMs: 3_000,
      });
      const raw = new McpServer({ name: "app", version: "1.0" });
      a.wrap(raw).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
      await callTool(raw, "get_price", { q: "x" });

      // A gives up at its own 300 ms, with the batch still on its way.
      const startedA = Date.now();
      await a.shutdown();
      expect(Date.now() - startedA).toBeLessThan(700);
      expect(allAnswered()).toBe(false);

      // B is the last holder: the transport's shutdown runs under B's 3 s,
      // so it waits for the answer instead of dropping the buffer at 300 ms.
      const answeredOnResolve = await b.shutdown().then(allAnswered);
      expect(answeredOnResolve).toBe(true);
      expect(toolCalls()).toHaveLength(1);
      expect(warn.mock.calls.map((c) => String(c[0]))).not.toContainEqual(
        expect.stringContaining("YAVIO-1205"),
      );
      expect(_sharedStateCount()).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it(
    "the withYavio() recipe: the signal drain, and so the handler's await shutdown(), is bounded by the withYavio() deadline, not the startup client's default",
    { timeout: 20_000 },
    async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await withoutOtherListeners("SIGTERM", async () => {
          ingest.hangEvents = true;
          // The README recipe as written: the shutdown client at startup
          // with no deadline of its own (10 s), the withYavio() call with
          // 300 ms. The drain a signal starts runs under the smallest value
          // configured for the key, so the handler resolves at about 300 ms
          // (review round 2: 9974 ms with the creator's value).
          const options = { apiKey: "yav_142_min", endpoint: ingest.endpoint, serverOnly: true };
          const analytics = createYavio(options);
          const raw = new McpServer({ name: "app", version: "1.0" });
          withYavio(raw, { ...options, shutdownTimeoutMs: 300 }).registerTool(
            "get_price",
            { inputSchema: { q: z.string() } },
            ok,
          );
          await callTool(raw, "get_price", { q: "x" });
          let elapsed: number | undefined;
          const handled = new Promise<void>((resolve) => {
            process.on("SIGTERM", async function app() {
              process.off("SIGTERM", app);
              const started = Date.now();
              await analytics.shutdown();
              elapsed = Date.now() - started;
              resolve();
            });
          });
          process.emit("SIGTERM", "SIGTERM");
          await handled;
          expect(elapsed).toBeGreaterThanOrEqual(250);
          expect(elapsed).toBeLessThan(2_000);
          expect(ingest.batches).toHaveLength(1); // sent, never answered
          expect(ingest.responded).toBe(0);
          expect(_sharedStateCount()).toBe(0);
        });
      } finally {
        await ingest.answerHung();
        warn.mockRestore();
      }
    },
  );

  it("two holders, one key: the signal drain runs under the smallest shutdownTimeoutMs, not the transport creator's", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withoutOtherListeners("SIGTERM", async () => {
        ingest.hangEvents = true;
        // A creates the key's transport with 3 s; B holds it with 300 ms.
        // The grace period is per process, so the strictest bound wins and
        // even A's own shutdown() in the handler sees 300 ms.
        const a = createYavio({
          apiKey: "yav_142_least",
          endpoint: ingest.endpoint,
          serverOnly: true,
          shutdownTimeoutMs: 3_000,
        });
        const b = createYavio({
          apiKey: "yav_142_least",
          endpoint: ingest.endpoint,
          serverOnly: true,
          shutdownTimeoutMs: 300,
        });
        const raw = new McpServer({ name: "app", version: "1.0" });
        a.wrap(raw).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
        await callTool(raw, "get_price", { q: "x" });
        let elapsed: number | undefined;
        const handled = new Promise<void>((resolve) => {
          process.on("SIGTERM", async function app() {
            process.off("SIGTERM", app);
            const started = Date.now();
            await a.shutdown();
            elapsed = Date.now() - started;
            resolve();
          });
        });
        process.emit("SIGTERM", "SIGTERM");
        await handled;
        expect(elapsed).toBeGreaterThanOrEqual(250);
        expect(elapsed).toBeLessThan(2_000);
        expect(ingest.batches).toHaveLength(1);
        expect(ingest.responded).toBe(0);
        await b.shutdown(); // nothing left to deliver: resolves at once
        expect(_sharedStateCount()).toBe(0);
      });
    } finally {
      await ingest.answerHung();
      warn.mockRestore();
    }
  });

  it("withYavio() hosts: the recipe's shutdown client, created at startup, awaits the signal drain", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      // The documented recipe: withYavio() has no client of its own, so one
      // is created once at startup for the same key and endpoint, used only
      // for shutdown(). Created inside the handler instead — after the SDK's
      // listener handed the signal back — it would install the SDK's
      // listeners again and leave them behind (review 8).
      const options = { apiKey: "yav_142_with", endpoint: ingest.endpoint, serverOnly: true };
      const analytics = createYavio(options);
      const raw = new McpServer({ name: "app", version: "1.0" });
      withYavio(raw, options).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
      await callTool(raw, "get_price", { q: "x" });
      let answeredOnResolve: boolean | undefined;
      const handled = new Promise<void>((resolve) => {
        process.on("SIGTERM", async function app() {
          process.off("SIGTERM", app);
          await analytics.shutdown();
          answeredOnResolve = allAnswered();
          resolve();
        });
      });
      process.emit("SIGTERM", "SIGTERM");
      await handled;
      expect(answeredOnResolve).toBe(true);
      expect(toolCalls()).toHaveLength(1);
      expect(process.listenerCount("SIGTERM")).toBe(0);
      expect(_sharedStateCount()).toBe(0);
    });
  });

  it("the recipe's await after http.close: a request served meanwhile is delivered and no SDK listener remains", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      const options = { apiKey: "yav_142_order", endpoint: ingest.endpoint, serverOnly: true };
      const analytics = createYavio(options);
      const raw = new McpServer({ name: "app", version: "1.0" });
      withYavio(raw, options).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
      await callTool(raw, "get_price", { q: "before" });
      let answeredOnResolve: boolean | undefined;
      let listenersOnResolve: number | undefined;
      const handled = new Promise<void>((resolve) => {
        process.on("SIGTERM", async function app() {
          process.off("SIGTERM", app);
          // `await new Promise((r) => http.close(r))`: the request still being
          // served finishes while the SDK's drain is already running.
          await callTool(raw, "get_price", { q: "in-flight" });
          await analytics.shutdown();
          answeredOnResolve = allAnswered();
          listenersOnResolve = process.listenerCount("SIGTERM");
          resolve();
        });
      });
      process.emit("SIGTERM", "SIGTERM");
      await handled;
      expect(answeredOnResolve).toBe(true);
      expect(toolCalls().map((e) => (e.input_values as { q: string }).q)).toEqual([
        "before",
        "in-flight",
      ]);
      // The SDK stepped aside when its drain was done and nothing re-installed it.
      expect(listenersOnResolve).toBe(0);
      expect(process.listenerCount("SIGTERM")).toBe(0);
      expect(_sharedStateCount()).toBe(0);
    });
  });
});
