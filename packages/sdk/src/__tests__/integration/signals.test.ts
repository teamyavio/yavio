/**
 * Signal hand-back (#138): the SDK's SIGTERM/SIGINT listeners drain the
 * registry and then step aside. Any listener on a signal replaces Node's
 * default exit, so an app without a handler of its own would otherwise keep
 * running after Ctrl-C or `docker stop` once the SDK had drained.
 */
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createYavio, withYavio } from "../../server/index.js";
import { _resetGlobalState } from "../../server/proxy.js";
import {
  _setSignalReraise,
  _sharedStateCount,
  _trackedTransportCount,
} from "../../server/shared.js";
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

/**
 * The cycle's line before a re-raise is written with `fs.writeSync(2, …)`
 * (#148 review round 2): record what goes to fd 2 in `lines` instead of
 * printing it, and let every other write through.
 */
function spyStderr(lines: string[]): ReturnType<typeof vi.spyOn> {
  const real = fs.writeSync;
  return vi.spyOn(fs, "writeSync").mockImplementation(((
    fd: number,
    data: unknown,
    ...rest: unknown[]
  ): number => {
    if (fd !== 2) return Reflect.apply(real, fs, [fd, data, ...rest]) as number;
    lines.push(String(data).trimEnd());
    return String(data).length;
  }) as typeof fs.writeSync);
}

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

  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    _resetGlobalState(); // also restores the real re-raise
    reraised = [];
    _setSignalReraise((signal) => reraised.push({ signal, delivered: deliveredCalls() }));
    stderr = spyStderr([]);
    ingest = await startMockIngest();
  });

  afterEach(async () => {
    _resetGlobalState();
    stderr.mockRestore();
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

  it("a second identical signal within 250 ms is the same delivery; one after that hands back at once, and only once (#148)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withoutOtherListeners("SIGINT", async () => {
        ingest.hangEvents = true;
        const raw = new McpServer({ name: "app", version: "1.0" });
        withYavio(raw, {
          apiKey: "yav_sig_twice",
          endpoint: ingest.endpoint,
          serverOnly: true,
          shutdownTimeoutMs: 600,
        }).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
        await callTool(raw, "get_price", { q: "x" });

        process.emit("SIGINT", "SIGINT"); // starts the drain
        process.emit("SIGINT", "SIGINT"); // `npm run` forwarding the terminal's Ctrl-C a few ms later
        // The same delivery: not handed back, the drain goes on (before
        // #148 this hand-back cut the drain at 40 ms, the batch unanswered).
        expect(reraised).toEqual([]);
        expect(process.listenerCount("SIGINT")).toBe(1);

        await new Promise((r) => setTimeout(r, 300));
        process.emit("SIGINT", "SIGINT"); // an impatient second Ctrl-C, after the window
        // Handed back synchronously: the batch had reached ingest (the mock
        // records on receipt) but nothing was answered.
        expect(reraised).toEqual([{ signal: "SIGINT", delivered: 1 }]);
        expect(ingest.responded).toBe(0);
        expect(process.listenerCount("SIGINT")).toBe(0);

        // The drain that was already running still ends at its deadline, without a second hand-back.
        await new Promise((r) => setTimeout(r, 500));
        expect(reraised).toHaveLength(1);
        expect(ingest.batches).toHaveLength(1);
      });
    } finally {
      await ingest.answerHung();
      warn.mockRestore();
    }
  });

  it("a signal during a releasing last holder with an explicit 20 s uses 20 s and waits for the stop in progress (#148)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withoutOtherListeners("SIGTERM", async () => {
        // The last holder's shutdown() stopped the transport outside a
        // signal and is waiting for ingest when the signal arrives. Before
        // #148 the drain found an empty registry, took the SDK for the only
        // listener and re-raised at once, mid-send; and the releasing hold's
        // value no longer counted, so D would have been the 4 s default,
        // short of the answer at 4.5 s.
        ingest.respondAfterMs = 4_500;
        let answeredAtReraise: number | undefined;
        _setSignalReraise((signal) => {
          answeredAtReraise = ingest.responded;
          reraised.push({ signal, delivered: deliveredCalls() });
        });
        const client = createYavio({
          apiKey: "yav_sig_release",
          endpoint: ingest.endpoint,
          serverOnly: true,
          shutdownTimeoutMs: 20_000,
        });
        const raw = new McpServer({ name: "app", version: "1.0" });
        client.wrap(raw).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
        await callTool(raw, "get_price", { q: "x" });
        const closing = client.shutdown();
        await new Promise((r) => setTimeout(r, 50));
        const signalAt = Date.now();
        process.emit("SIGTERM", "SIGTERM");
        await vi.waitFor(() => expect(reraised).toHaveLength(1), { timeout: 10_000 });
        // Re-raised only after the batch was answered, at about 4.5 s (the
        // mock records events on receipt, so `delivered` alone would not tell).
        expect(answeredAtReraise).toBe(1);
        expect(reraised[0]).toEqual({ signal: "SIGTERM", delivered: 1 });
        expect(Date.now() - signalAt).toBeGreaterThanOrEqual(4_300);
        await closing;
        expect(ingest.responded).toBe(1);
        expect(warn.mock.calls.map((c) => String(c[0]))).not.toContainEqual(
          expect.stringContaining("YAVIO-1205"),
        );
      });
    } finally {
      warn.mockRestore();
    }
  }, 15_000);

  it("each cycle has an identity: a drain that ends after its cycle was handed back cannot end a later cycle (#148)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withoutOtherListeners("SIGINT", async () => {
        ingest.hangEvents = true;
        const options = {
          apiKey: "yav_sig_cycles",
          endpoint: ingest.endpoint,
          serverOnly: true,
          shutdownTimeoutMs: 1_000,
        };
        const raw = new McpServer({ name: "app", version: "1.0" });
        withYavio(raw, options).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
        await callTool(raw, "get_price", { q: "first" });
        const t0 = Date.now();
        process.emit("SIGINT", "SIGINT"); // cycle 1: its drain hangs until t0 + 1 s
        await new Promise((r) => setTimeout(r, 300));
        process.emit("SIGINT", "SIGINT"); // impatient: cycle 1 handed back now, its drain still running
        expect(reraised).toHaveLength(1);

        // The process survived (the re-raise is stubbed here, as with an app
        // listener elsewhere): a new wrap re-installs the listeners and the
        // next signal starts cycle 2, with its own deadline at t0 + 1.3 s.
        const next = new McpServer({ name: "next", version: "1.0" });
        withYavio(next, options).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
        await callTool(next, "get_price", { q: "second" });
        expect(process.listenerCount("SIGINT")).toBe(1);
        process.emit("SIGINT", "SIGINT");

        // At t0 + 1.1 s cycle 1's drain has ended; cycle 2 must still be running.
        await new Promise((r) => setTimeout(r, 1_100 - (Date.now() - t0)));
        expect(process.listenerCount("SIGINT")).toBe(1);
        expect(reraised).toHaveLength(1);
        await vi.waitFor(() => expect(reraised).toHaveLength(2), { timeout: 2_000 });
        expect(Date.now() - t0).toBeGreaterThanOrEqual(1_250);
        expect(process.listenerCount("SIGINT")).toBe(0);
      });
    } finally {
      await ingest.answerHung();
      warn.mockRestore();
    }
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

  it(
    "a participant on the default does not lower the bound: the recipe with 5 s on the startup client and a plain withYavio() delivers at 4.5 s",
    { timeout: 20_000 },
    async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await withoutOtherListeners("SIGTERM", async () => {
          // The README recipe with the deadline raised above the default on
          // the shutdown client only. Every resolved config carries a
          // value, and registering the withYavio() call's default capped
          // the drain at the default (review round 3 of #142: 9985 ms,
          // YAVIO-1205, the batch lost, when the default was 10 s). Only
          // values set explicitly bound the drain, so the batch ingest
          // answers after 4.5 s — past the 4 s default — is delivered. No
          // way to scale this down: the cap an unset participant would add
          // is the default itself.
          ingest.respondAfterMs = 4_500;
          const options = { apiKey: "yav_142_raised", endpoint: ingest.endpoint, serverOnly: true };
          const analytics = createYavio({ ...options, shutdownTimeoutMs: 5_000 });
          const raw = new McpServer({ name: "app", version: "1.0" });
          withYavio(raw, options).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
          await callTool(raw, "get_price", { q: "x" });
          let elapsed: number | undefined;
          let answeredOnResolve: boolean | undefined;
          const handled = new Promise<void>((resolve) => {
            process.on("SIGTERM", async function app() {
              process.off("SIGTERM", app);
              const started = Date.now();
              await analytics.shutdown();
              elapsed = Date.now() - started;
              answeredOnResolve = allAnswered();
              resolve();
            });
          });
          process.emit("SIGTERM", "SIGTERM");
          await handled;
          expect(answeredOnResolve).toBe(true);
          expect(elapsed).toBeGreaterThanOrEqual(4_400);
          expect(elapsed).toBeLessThan(6_000);
          expect(toolCalls()).toHaveLength(1);
          expect(warn.mock.calls.map((c) => String(c[0]))).not.toContainEqual(
            expect.stringContaining("YAVIO-1205"),
          );
          expect(_sharedStateCount()).toBe(0);
        });
      } finally {
        warn.mockRestore();
      }
    },
  );

  it(
    "two clients, one key, 5 s and the default: the signal drain is bounded by the 5 s, not capped at 4 s by the client that set none",
    { timeout: 20_000 },
    async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await withoutOtherListeners("SIGTERM", async () => {
          // The two-holder case of the round-3 probe (9984 ms, the event lost,
          // under the 10 s default). The default client creates the transport
          // and the 5 s one joins second, so a drain that fell back to the
          // creator's value or took the minimum with it would be caught
          // (review round 4).
          ingest.respondAfterMs = 4_500;
          const options = {
            apiKey: "yav_142_raised2",
            endpoint: ingest.endpoint,
            serverOnly: true,
          };
          const b = createYavio(options);
          const a = createYavio({ ...options, shutdownTimeoutMs: 5_000 });
          const raw = new McpServer({ name: "app", version: "1.0" });
          a.wrap(raw).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
          await callTool(raw, "get_price", { q: "x" });
          let elapsed: number | undefined;
          let answeredOnResolve: boolean | undefined;
          const handled = new Promise<void>((resolve) => {
            process.on("SIGTERM", async function app() {
              process.off("SIGTERM", app);
              const started = Date.now();
              await a.shutdown();
              elapsed = Date.now() - started;
              answeredOnResolve = allAnswered();
              resolve();
            });
          });
          process.emit("SIGTERM", "SIGTERM");
          await handled;
          expect(answeredOnResolve).toBe(true);
          expect(elapsed).toBeGreaterThanOrEqual(4_400);
          expect(elapsed).toBeLessThan(6_000);
          expect(toolCalls()).toHaveLength(1);
          expect(warn.mock.calls.map((c) => String(c[0]))).not.toContainEqual(
            expect.stringContaining("YAVIO-1205"),
          );
          await b.shutdown(); // nothing left to deliver: resolves at once
          expect(_sharedStateCount()).toBe(0);
        });
      } finally {
        warn.mockRestore();
      }
    },
  );

  it(
    "a released creator's deadline does not bound the drain: with nothing set explicitly it is 4 s",
    { timeout: 20_000 },
    async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await withoutOtherListeners("SIGTERM", async () => {
          // Review round 4 probe of #142: A creates the key's transport with
          // 300 ms and releases outside a signal; B, on the default, holds
          // it. The drain fell back to the transport's own value — A's
          // 300 ms — and B's handler shutdown() resolved at 299 ms with
          // YAVIO-1205, the batch lost. Nothing set explicitly means the
          // default: 4 s since #148 (10 s before), measured against an
          // ingest that never answers.
          ingest.hangEvents = true;
          const options = { apiKey: "yav_142_gone", endpoint: ingest.endpoint, serverOnly: true };
          const a = createYavio({ ...options, shutdownTimeoutMs: 300 });
          const b = createYavio(options);
          await a.shutdown(); // nothing queued: releases A's hold at once
          const raw = new McpServer({ name: "app", version: "1.0" });
          b.wrap(raw).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
          await callTool(raw, "get_price", { q: "x" });
          let elapsed: number | undefined;
          const handled = new Promise<void>((resolve) => {
            process.on("SIGTERM", async function app() {
              process.off("SIGTERM", app);
              const started = Date.now();
              await b.shutdown();
              elapsed = Date.now() - started;
              resolve();
            });
          });
          process.emit("SIGTERM", "SIGTERM");
          await handled;
          expect(elapsed).toBeGreaterThanOrEqual(3_900);
          expect(elapsed).toBeLessThan(4_600);
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

/**
 * One process deadline from the signal (#148, Decision A): signal + D,
 * where D is the smallest `shutdownTimeoutMs` set explicitly by any live
 * hold, pin or `shutdown()` in progress across every key, else 4 s. The
 * signal drain, every release drain and every `shutdown()` running at or
 * after the signal resolve by then. Before #148 each key drained under its
 * own smallest value, a `shutdown()` call ran its own deadline from its
 * call, and the post-signal transport added a third one.
 */
describe("one process deadline from the signal (#148)", () => {
  let ingest: MockIngest;
  let warn: ReturnType<typeof vi.spyOn>;

  function build(apiKey: string, options: { shutdownTimeoutMs?: number } = {}) {
    const client = createYavio({ apiKey, endpoint: ingest.endpoint, serverOnly: true, ...options });
    const raw = new McpServer({ name: "app", version: "1.0" });
    client.wrap(raw).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
    return { client, raw };
  }

  /** Install an app SIGTERM listener that runs `handler` once and resolves with its timings. */
  function onSigterm(handler: () => Promise<void>): Promise<{ fromSignal: number }> {
    return new Promise((resolve) => {
      process.on("SIGTERM", async function app() {
        process.off("SIGTERM", app);
        const signalAt = Date.now();
        await handler();
        resolve({ fromSignal: Date.now() - signalAt });
      });
    });
  }

  beforeEach(async () => {
    _resetGlobalState();
    _setSignalReraise(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ingest = await startMockIngest();
    ingest.hangEvents = true;
  });

  afterEach(async () => {
    await ingest.answerHung();
    _resetGlobalState();
    warn.mockRestore();
    await ingest.close();
  });

  it("one deadline across keys: a client with 3 s on key A and a pin with 300 ms on key B — A's handler shutdown() resolves at about 300 ms", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      const { client: a, raw } = build("yav_148_a", { shutdownTimeoutMs: 3_000 });
      await callTool(raw, "get_price", { q: "x" });
      const other = new McpServer({ name: "other", version: "1.0" });
      withYavio(other, {
        apiKey: "yav_148_b",
        endpoint: ingest.endpoint,
        serverOnly: true,
        shutdownTimeoutMs: 300,
      }).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
      await callTool(other, "get_price", { q: "y" });
      const handled = onSigterm(() => a.shutdown());
      process.emit("SIGTERM", "SIGTERM");
      const { fromSignal } = await handled;
      // The grace period is per process: the strictest explicit value wins
      // for every key, and A's own 3 s does not extend the wait.
      expect(fromSignal).toBeGreaterThanOrEqual(250);
      expect(fromSignal).toBeLessThan(1_000);
      expect(ingest.batches).toHaveLength(2); // both keys sent, never answered
      expect(ingest.responded).toBe(0);
    });
  });

  it("the deadline counts from the signal: a handler that waits 1 s with an explicit 1.5 s resolves at about 1.5 s after the signal", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      const { client, raw } = build("yav_148_from_signal", { shutdownTimeoutMs: 1_500 });
      await callTool(raw, "get_price", { q: "before" });
      const handled = onSigterm(async () => {
        // `await closeWithin(http, …)`: a request finishing after the signal
        // sends its event through the key's immediate transport meanwhile.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        await callTool(raw, "get_price", { q: "after" });
        await client.shutdown();
      });
      process.emit("SIGTERM", "SIGTERM");
      const { fromSignal } = await handled;
      // Not 1 s + 1.5 s: the call's own clock does not start at the call.
      expect(fromSignal).toBeGreaterThanOrEqual(1_400);
      expect(fromSignal).toBeLessThan(2_200);
      expect(ingest.batches).toHaveLength(2);
      expect(ingest.responded).toBe(0);
    });
  });

  it("a shutdown() that started before the signal is cut at the deadline", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      // A (3 s) releases while B (300 ms) still holds the key, so A's
      // release drains the transport under A's 3 s. The signal 100 ms later
      // fixes D = 300 ms, and A's pending await ends at signal + D.
      const { client: a, raw } = build("yav_148_cut", { shutdownTimeoutMs: 3_000 });
      const b = createYavio({
        apiKey: "yav_148_cut",
        endpoint: ingest.endpoint,
        serverOnly: true,
        shutdownTimeoutMs: 300,
      });
      await callTool(raw, "get_price", { q: "x" });
      const started = Date.now();
      const closing = a.shutdown().then(() => Date.now() - started);
      await new Promise((resolve) => setTimeout(resolve, 100));
      process.emit("SIGTERM", "SIGTERM");
      const elapsed = await closing;
      expect(elapsed).toBeGreaterThanOrEqual(350);
      expect(elapsed).toBeLessThan(1_000);
      await b.shutdown();
    });
  });

  it("a shutdown() called with no time left resolves at once", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      const { client: a, raw } = build("yav_148_late", { shutdownTimeoutMs: 3_000 });
      await callTool(raw, "get_price", { q: "x" });
      const other = new McpServer({ name: "other", version: "1.0" });
      withYavio(other, {
        apiKey: "yav_148_late_b",
        endpoint: ingest.endpoint,
        serverOnly: true,
        shutdownTimeoutMs: 300,
      }).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
      await callTool(other, "get_price", { q: "y" });
      let elapsed: number | undefined;
      const handled = onSigterm(async () => {
        await new Promise((resolve) => setTimeout(resolve, 600)); // past signal + D
        const started = Date.now();
        await a.shutdown();
        elapsed = Date.now() - started;
      });
      process.emit("SIGTERM", "SIGTERM");
      await handled;
      // Not A's 3 s, and not the rest of A's key's drain either.
      expect(elapsed).toBeLessThan(150);
    });
  });

  it("a send() after the hand-back still goes out, and a shutdown() after it waits at most D from its call", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      process.env.YAVIO_SHUTDOWN_TIMEOUT_MS = "300";
      try {
        const { client, raw } = build("yav_148_after", { shutdownTimeoutMs: 3_000 });
        await callTool(raw, "get_price", { q: "before" });
        process.emit("SIGTERM", "SIGTERM"); // nothing else listens: the SDK drains and hands back
        await vi.waitFor(() => expect(process.listenerCount("SIGTERM")).toBe(0), {
          timeout: 2_000,
        });
        // The process survived (a platform that did not kill it yet, a
        // handler elsewhere): a request finishing now sends through a new
        // immediate transport — one attempt, a fetch bounded by D.
        await callTool(raw, "get_price", { q: "after" });
        await vi.waitFor(() => expect(ingest.batches).toHaveLength(2));
        const started = Date.now();
        await client.shutdown();
        const elapsed = Date.now() - started;
        // At most D (300 ms: the immediate transport's fetch gives up at
        // min(30 s, D) from its send, the drain at D from the call), not
        // the client's own 3 s: the exit is no longer blocked.
        expect(elapsed).toBeGreaterThanOrEqual(150);
        expect(elapsed).toBeLessThan(1_000);
        expect(
          ingest.events.map((e) => (e.input_values as { q?: string } | undefined)?.q),
        ).toContain("after");
      } finally {
        process.env.YAVIO_SHUTDOWN_TIMEOUT_MS = undefined;
      }
    });
  });

  it("YAVIO_SHUTDOWN_TIMEOUT_MS counts even when no participant set a value: a plain client is bounded by it", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      process.env.YAVIO_SHUTDOWN_TIMEOUT_MS = "300";
      try {
        // Resolved with the option, so the client's own value is 3 s and
        // its source is "option": the env var is not among the registered
        // deadlines, yet it bounds the process.
        const { client, raw } = build("yav_148_env", { shutdownTimeoutMs: 3_000 });
        await callTool(raw, "get_price", { q: "x" });
        const handled = onSigterm(() => client.shutdown());
        process.emit("SIGTERM", "SIGTERM");
        const { fromSignal } = await handled;
        expect(fromSignal).toBeGreaterThanOrEqual(250);
        expect(fromSignal).toBeLessThan(1_000);
      } finally {
        process.env.YAVIO_SHUTDOWN_TIMEOUT_MS = undefined;
      }
    });
  });
});

/**
 * Loss accounting (#148, Decision C): one `YAVIO-1205` line per signal
 * cycle with the count of events not delivered, printed before the
 * re-raise; a non-signal `shutdown()` that times out prints its own line
 * with its own count; an app that exits before its `shutdown()` resolved
 * gets one line from an `exit` hook that is armed only after a signal or a
 * started `shutdown()`. Before #148 the line had no count, a drain that
 * ran out of time logged nothing, and the post-signal transport's loss
 * was silent.
 */
describe("loss accounting (#148)", () => {
  let ingest: MockIngest;
  let warn: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;
  /** Every `console.warn` line and every line written to fd 2, in order. */
  let lines: string[];
  const lines1205 = () => lines.filter((l) => l.includes("YAVIO-1205"));
  const exitHooks = () => process.listeners("exit").filter((l) => l.name === "yavioReportAtExit");

  function build(apiKey: string, options: { shutdownTimeoutMs?: number } = {}) {
    const client = createYavio({ apiKey, endpoint: ingest.endpoint, serverOnly: true, ...options });
    const raw = new McpServer({ name: "app", version: "1.0" });
    client.wrap(raw).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
    return { client, raw };
  }

  beforeEach(async () => {
    _resetGlobalState();
    lines = [];
    warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(String(args[0]));
    });
    stderr = spyStderr(lines);
    ingest = await startMockIngest();
    ingest.hangEvents = true;
  });

  afterEach(async () => {
    await ingest.answerHung();
    _resetGlobalState();
    warn.mockRestore();
    stderr.mockRestore();
    await ingest.close();
  });

  it("one line per signal cycle, with the count of every transport's loss and what the re-raise cuts, printed before the re-raise", async () => {
    let linesAtReraise: number | undefined;
    _setSignalReraise(() => {
      linesAtReraise = lines1205().length;
    });
    await withoutOtherListeners("SIGTERM", async () => {
      // Two keys, each with a connection and a tool_call queued; the request
      // finishing after the signal sends a fifth event through an immediate
      // transport, still in flight when the SDK — the only listener — re-raises.
      const { raw } = build("yav_148_count_a", { shutdownTimeoutMs: 300 });
      await callTool(raw, "get_price", { q: "a" });
      const { raw: other } = build("yav_148_count_b");
      await callTool(other, "get_price", { q: "b" });
      process.emit("SIGTERM", "SIGTERM");
      await callTool(raw, "get_price", { q: "late" });
      await vi.waitFor(() => expect(linesAtReraise).toBeDefined(), { timeout: 2_000 });
      expect(linesAtReraise).toBe(1);
      expect(lines1205()).toHaveLength(1);
      expect(lines1205()[0]).toContain("deadline of 300 ms");
      expect(lines1205()[0]).toContain("5 events not delivered");
      expect(lines1205()[0]).toContain("shutdownTimeoutMs");
      // Written synchronously to fd 2, not through console.warn: where
      // stderr is an asynchronous pipe the re-raise would lose the line.
      expect(stderr).toHaveBeenCalledWith(2, expect.stringContaining("YAVIO-1205"));
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("YAVIO-1205"));
      expect(ingest.batches).toHaveLength(3); // every batch reached ingest, none was answered
    });
  });

  it("with an app handler: the cycle's line counts the drained transports; an exit before shutdown() resolved gets one more line from the exit hook, which a plain exit never arms", async () => {
    _setSignalReraise(() => {});
    await withoutOtherListeners("SIGTERM", async () => {
      const { client, raw } = build("yav_148_exit", { shutdownTimeoutMs: 300 });
      await callTool(raw, "get_price", { q: "x" });
      expect(exitHooks()).toHaveLength(0); // nothing armed: a plain exit prints nothing
      const handled = new Promise<void>((resolve) => {
        process.on("SIGTERM", async function app() {
          process.off("SIGTERM", app);
          await callTool(raw, "get_price", { q: "late" }); // finishes after the signal, hangs in flight
          await client.shutdown();
          resolve();
        });
      });
      process.emit("SIGTERM", "SIGTERM");
      await handled;
      expect(exitHooks()).toHaveLength(1);
      // The cycle ends in the same timer tick the handler's await is cut in.
      await vi.waitFor(() => expect(lines1205()).toHaveLength(1));
      expect(lines1205()[0]).toContain("2 events not delivered"); // connection + the first call
      // `process.exit(0)` now: the late call's event is still in flight.
      exitHooks()[0]?.call(process, 0);
      expect(lines1205()).toHaveLength(2);
      expect(lines1205()[1]).toContain("1 events not delivered");
      exitHooks()[0]?.call(process, 0);
      expect(lines1205()).toHaveLength(2); // counted once
    });
  });

  it("a re-raise that ends the process through process.exit() — win32, or process.kill throwing — adds no second line for the in-flight events the cycle's line counted", async () => {
    // What defaultReraise does there: process.exit(), whose exit listeners
    // run inside it, right after the cycle's line.
    _setSignalReraise(() => {
      exitHooks()[0]?.call(process, 0);
    });
    await withoutOtherListeners("SIGTERM", async () => {
      const { raw } = build("yav_148_exit_in_reraise", { shutdownTimeoutMs: 300 });
      await callTool(raw, "get_price", { q: "x" });
      process.emit("SIGTERM", "SIGTERM");
      await callTool(raw, "get_price", { q: "late" }); // in flight at the hand-back
      await vi.waitFor(() => expect(process.listenerCount("SIGTERM")).toBe(0), {
        timeout: 2_000,
      });
      // The cycle's line: the two events the deadline gave up plus the one
      // in flight. Before the fix the exit hook, run by process.exit()
      // inside the re-raise, printed "Process exit with 1 events not
      // delivered" for that same in-flight event.
      expect(lines1205()).toHaveLength(1);
      expect(lines1205()[0]).toContain("Shutdown deadline of 300 ms");
      expect(lines1205()[0]).toContain("3 events not delivered");
    });
  });

  it("a batch given up for good before the signal (a 400 at noon) is no deadline loss: a healthy drain prints no line, and the exit hook nothing", async () => {
    _setSignalReraise(() => {});
    await withoutOtherListeners("SIGTERM", async () => {
      ingest.hangEvents = false;
      ingest.failWith = 400;
      // Two holders of one key: A's shutdown() drains the transport without
      // stopping it (B keeps it), so the batch goes out hours before the signal.
      const b = createYavio({
        apiKey: "yav_148_failed_before",
        endpoint: ingest.endpoint,
        serverOnly: true,
      });
      const { client: a, raw } = build("yav_148_failed_before");
      await callTool(raw, "get_price", { q: "noon" });
      await a.shutdown(); // answered 400: given up for good, not by a deadline
      expect(ingest.batches).toHaveLength(1);
      expect(ingest.responded).toBe(1);
      expect(lines1205()).toHaveLength(0);

      // Much later: ingest healthy, a new request, the signal, a drain that delivers.
      ingest.failWith = undefined;
      await callTool(raw, "get_price", { q: "later" });
      process.emit("SIGTERM", "SIGTERM");
      await vi.waitFor(() => expect(process.listenerCount("SIGTERM")).toBe(0), {
        timeout: 2_000,
      });
      expect(ingest.responded).toBe(2);
      // Before the fix the cycle's line re-reported the 400's two events:
      // "Shutdown deadline of 4000 ms reached — 2 events not delivered".
      expect(lines1205()).toHaveLength(0);
      exitHooks()[0]?.call(process, 0);
      expect(lines1205()).toHaveLength(0);
      await b.shutdown();
    });
  });

  it("a non-signal shutdown() that times out prints its own line with its own count", async () => {
    const { client, raw } = build("yav_148_call", { shutdownTimeoutMs: 300 });
    await callTool(raw, "get_price", { q: "x" });
    expect(exitHooks()).toHaveLength(0);
    await client.shutdown();
    expect(exitHooks()).toHaveLength(1); // armed by the started shutdown()
    expect(lines1205()).toHaveLength(1);
    expect(lines1205()[0]).toContain("shutdown() deadline of 300 ms");
    expect(lines1205()[0]).toContain("2 events not delivered");
    // Nothing left unreported: the exit hook stays quiet.
    exitHooks()[0]?.call(process, 0);
    expect(lines1205()).toHaveLength(1);
  });

  it("a cycle handed back early, as the only listener: the stops' later deadline loss adds no second line", async () => {
    _setSignalReraise(() => {});
    await withoutOtherListeners("SIGTERM", async () => {
      await withoutOtherListeners("SIGINT", async () => {
        const { raw } = build("yav_148_late_sole", { shutdownTimeoutMs: 600 });
        await callTool(raw, "get_price", { q: "x" });
        process.emit("SIGTERM", "SIGTERM"); // the cycle: its stop hangs until the 600 ms deadline
        await new Promise((r) => setTimeout(r, 300));
        process.emit("SIGINT", "SIGINT"); // a different signal: handed back at once
        // The cycle's line, with the two events in flight the re-raise would cut.
        expect(lines1205()).toHaveLength(1);
        expect(lines1205()[0]).toContain("Shutdown deadline of 600 ms");
        expect(lines1205()[0]).toContain("2 events not delivered");
        // The stop reaches its deadline after the hand-back: before the fix
        // that printed a second line, "shutdown() deadline of 600 ms reached
        // — 2 events", for events the cycle's line had already counted.
        await new Promise((r) => setTimeout(r, 500));
        expect(lines1205()).toHaveLength(1);
      });
    });
  });

  it("a cycle handed back early, next to an app listener: the stops' later deadline loss is one line with the cycle's wording", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      await withoutOtherListeners("SIGINT", async () => {
        const app = vi.fn();
        process.on("SIGTERM", app);
        try {
          const { raw } = build("yav_148_late_app", { shutdownTimeoutMs: 600 });
          await callTool(raw, "get_price", { q: "x" });
          process.emit("SIGTERM", "SIGTERM");
          await new Promise((r) => setTimeout(r, 300));
          process.emit("SIGINT", "SIGINT"); // handed back; nothing lost yet, so no line
          expect(lines1205()).toHaveLength(0);
          await new Promise((r) => setTimeout(r, 500));
          // The two events the stop gave up at the cycle's deadline, once,
          // as the cycle's — not as a per-transport "shutdown() deadline".
          expect(lines1205()).toHaveLength(1);
          expect(lines1205()[0]).toContain("Shutdown deadline of 600 ms");
          expect(lines1205()[0]).toContain("2 events not delivered");
          expect(lines1205()[0]).not.toContain("shutdown() deadline");
          exitHooks()[0]?.call(process, 0);
          expect(lines1205()).toHaveLength(1); // nothing left unreported
        } finally {
          process.off("SIGTERM", app);
        }
      });
    });
  });

  it("a client created and shut down per request leaves no transport behind, and its losses stay counted", async () => {
    // A stateless host that follows the README per request: before the fix
    // every transport stayed in the registry's set for the process lifetime.
    ingest.hangEvents = false;
    const baseline = _trackedTransportCount();
    for (let i = 0; i < 20; i++) {
      const { client, raw } = build("yav_148_per_request");
      await callTool(raw, "get_price", { q: String(i) });
      await client.shutdown();
    }
    expect(_trackedTransportCount()).toBe(baseline);
    expect(lines1205()).toHaveLength(0);

    // Losses of a transport that left the set are still in the total: three
    // timed-out shutdowns, three lines of their own, nothing left over for
    // the exit hook to report twice or to forget.
    ingest.hangEvents = true;
    for (let i = 0; i < 3; i++) {
      const { client, raw } = build("yav_148_per_request_lost", { shutdownTimeoutMs: 100 });
      await callTool(raw, "get_price", { q: String(i) });
      await client.shutdown();
      await ingest.answerHung();
    }
    expect(_trackedTransportCount()).toBe(baseline);
    expect(lines1205()).toHaveLength(3);
    expect(lines1205()[0]).toContain("2 events not delivered"); // connection + call
    expect(lines1205()[2]).toContain("1 events not delivered"); // the connection is once per key
    exitHooks()[0]?.call(process, 0);
    expect(lines1205()).toHaveLength(3);
  });

  it("_resetSharedState() resets the deadline, the loss watermark and the exit hook", async () => {
    _setSignalReraise(() => {});
    await withoutOtherListeners("SIGTERM", async () => {
      const { raw } = build("yav_148_reset", { shutdownTimeoutMs: 300 });
      await callTool(raw, "get_price", { q: "x" });
      process.emit("SIGTERM", "SIGTERM");
      await vi.waitFor(() => expect(lines1205()).toHaveLength(1), { timeout: 2_000 });
      expect(exitHooks()).toHaveLength(1);
    });
    await ingest.answerHung();
    _resetGlobalState();
    expect(exitHooks()).toHaveLength(0);
    // A later shutdown() runs under its own 1 s, not under the stale 300 ms budget.
    const { client, raw } = build("yav_148_reset2", { shutdownTimeoutMs: 1_000 });
    await callTool(raw, "get_price", { q: "y" });
    const started = Date.now();
    await client.shutdown();
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(lines1205()).toHaveLength(2);
    expect(lines1205()[1]).toContain("2 events not delivered"); // its own count, not 4
  });
});
