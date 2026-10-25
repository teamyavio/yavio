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
  _appWaitCount,
  _setSignalReraise,
  _sharedStateCount,
  _trackedTransportCount,
  processBudgetMs,
} from "../../server/shared.js";
import { HttpTransport } from "../../transport/http.js";
import { restoreEnv } from "../env.js";
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

  it("a different signal during the drain is handed back for the signal that arrived: SIGINT next to the app's own SIGINT listener — no re-raise, the app keeps control (#148)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withoutOtherListeners("SIGTERM", async () => {
        await withoutOtherListeners("SIGINT", async () => {
          // An app that handles only SIGINT (a CLI, say) and relies on the
          // default for SIGTERM.
          const app = vi.fn();
          process.on("SIGINT", app);
          try {
            ingest.hangEvents = true;
            const raw = new McpServer({ name: "app", version: "1.0" });
            withYavio(raw, {
              apiKey: "yav_sig_other_signal",
              endpoint: ingest.endpoint,
              serverOnly: true,
              shutdownTimeoutMs: 600,
            }).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
            await callTool(raw, "get_price", { q: "x" });
            expect(process.listenerCount("SIGTERM")).toBe(1); // the SDK alone
            process.emit("SIGTERM", "SIGTERM"); // sole: the drain hangs to the 600 ms deadline
            await new Promise((r) => setTimeout(r, 100));
            process.emit("SIGINT", "SIGINT"); // the app's own signal, mid-drain
            // Handed back for SIGINT: the app's listener ran and decides
            // what happens next. Before the fix the cycle re-raised SIGTERM
            // with its own "sole" decision — the app, handling only SIGINT,
            // was killed by SIGTERM's default action (143) mid-shutdown.
            expect(reraised).toEqual([]);
            expect(app).toHaveBeenCalledTimes(1);
            expect(process.listenerCount("SIGTERM")).toBe(0);
            expect(process.rawListeners("SIGINT")).toEqual([app]);
            // The drain still ends at its deadline, without a hand-back of its own.
            await new Promise((r) => setTimeout(r, 700));
            expect(reraised).toEqual([]);
          } finally {
            process.off("SIGINT", app);
          }
        });
      });
    } finally {
      await ingest.answerHung();
      warn.mockRestore();
    }
  });

  it("the other way round: SIGTERM next to an app listener, then SIGINT with nothing else listening — SIGINT is re-raised, not SIGTERM (#148)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withoutOtherListeners("SIGTERM", async () => {
        await withoutOtherListeners("SIGINT", async () => {
          const app = vi.fn();
          process.on("SIGTERM", app);
          try {
            ingest.hangEvents = true;
            const raw = new McpServer({ name: "app", version: "1.0" });
            withYavio(raw, {
              apiKey: "yav_sig_other_signal_2",
              endpoint: ingest.endpoint,
              serverOnly: true,
              shutdownTimeoutMs: 600,
            }).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
            await callTool(raw, "get_price", { q: "x" });
            process.emit("SIGTERM", "SIGTERM"); // next to the app's listener: no re-raise for this one
            expect(app).toHaveBeenCalledTimes(1);
            await new Promise((r) => setTimeout(r, 100));
            process.emit("SIGINT", "SIGINT"); // nothing else listens: Node's default for SIGINT must run
            // Before the fix nothing was re-raised (the first signal's
            // decision), and the process stayed up with no handler for SIGINT.
            expect(reraised.map((r) => r.signal)).toEqual(["SIGINT"]);
            expect(process.listenerCount("SIGINT")).toBe(0);
            expect(process.rawListeners("SIGTERM")).toEqual([app]);
          } finally {
            process.off("SIGTERM", app);
          }
        });
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
        // Cycle 1's batch is answered at t0 + 600 ms; the batch sent after
        // the hand-back never is (its fetch is cut at the last cycle's
        // deadline, t0 + 1 s, review round 4), so cycle 2's stop outlives
        // cycle 1's drain.
        const q = (batch: { events: Array<Record<string, unknown>> }) =>
          batch.events.map((e) => (e.input_values as { q?: string } | undefined)?.q);
        ingest.respondAfterMs = (batch) => (q(batch).includes("first") ? 600 : 60_000);
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
        process.emit("SIGINT", "SIGINT"); // cycle 1: its drain waits for the answer at t0 + 600 ms
        await new Promise((r) => setTimeout(r, 300));
        process.emit("SIGINT", "SIGINT"); // impatient: cycle 1 handed back now, its drain still running
        expect(reraised).toHaveLength(1);

        // The process survived (the re-raise is stubbed here, as with an app
        // listener elsewhere): a new wrap re-installs the listeners and the
        // next signal starts cycle 2, whose stop waits for the second batch
        // until its fetch is cut at t0 + 1 s.
        const next = new McpServer({ name: "next", version: "1.0" });
        withYavio(next, options).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
        await callTool(next, "get_price", { q: "second" });
        expect(process.listenerCount("SIGINT")).toBe(1);
        process.emit("SIGINT", "SIGINT");

        // At t0 + 800 ms cycle 1's drain has ended; cycle 2 must still be running.
        await new Promise((r) => setTimeout(r, 800 - (Date.now() - t0)));
        expect(ingest.responded).toBe(1);
        expect(process.listenerCount("SIGINT")).toBe(1);
        expect(reraised).toHaveLength(1);
        await vi.waitFor(() => expect(reraised).toHaveLength(2), { timeout: 2_000 });
        expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
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
    // No test leaves the env var behind — and none leaves the string
    // "undefined" behind, which `process.env.X = undefined` stores.
    expect(process.env.YAVIO_SHUTDOWN_TIMEOUT_MS).toBeUndefined();
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
      const saved = process.env.YAVIO_SHUTDOWN_TIMEOUT_MS;
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
        restoreEnv("YAVIO_SHUTDOWN_TIMEOUT_MS", saved);
      }
    });
  });

  it("a send at signal + D − 100 ms against a hanging ingest: the post-signal transport's fetch is cut at the cycle's deadline, not D after its send", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      const { client, raw } = build("yav_148_late_fetch", { shutdownTimeoutMs: 1_000 });
      await callTool(raw, "get_price", { q: "before" });
      const handled = onSigterm(async () => {
        // `await closeWithin(http, …)`: the request in flight finishes just
        // before the deadline and sends through the immediate transport.
        await new Promise((resolve) => setTimeout(resolve, 900));
        await callTool(raw, "get_price", { q: "late" });
        await client.shutdown();
      });
      const signalAt = Date.now();
      process.emit("SIGTERM", "SIGTERM");
      await handled;
      await vi.waitFor(() => expect(ingest.batches).toHaveLength(2));
      const late = ingest.batches[1] as (typeof ingest.batches)[number];
      // Each fetch of that transport runs within what is left of the cycle
      // (100 ms at least), so the socket is gone by about signal + D and
      // nothing keeps a host without process.exit() alive. Before the fix
      // the transport, created at signal + 900 ms, got a fetch timeout of
      // min(30 s, D) = 1 s from then: aborted at signal + 1.9 s — up to
      // signal + 2D in general, past Fly.io's 5 s with the 4 s default.
      await vi.waitFor(() => expect(late.abortedAt).toBeDefined(), { timeout: 3_000 });
      const abortedAfter = (late.abortedAt as number) - signalAt;
      expect(abortedAfter).toBeGreaterThanOrEqual(950);
      expect(abortedAfter).toBeLessThan(1_400);
    });
  });

  it(
    "after an early, healthy hand-back a send at signal + 3 s with D = 4 s still runs within signal + D: the fetch is cut by the last cycle's deadline, not D after its send",
    { timeout: 15_000 },
    async () => {
      await withoutOtherListeners("SIGTERM", async () => {
        // Ingest healthy at the signal: the drain ends within a few ms and
        // the SDK — the only listener — hands back long before the deadline.
        ingest.hangEvents = false;
        const { raw } = build("yav_148_late_after_handback", { shutdownTimeoutMs: 4_000 });
        await callTool(raw, "get_price", { q: "before" });
        const signalAt = Date.now();
        process.emit("SIGTERM", "SIGTERM");
        await vi.waitFor(() => expect(process.listenerCount("SIGTERM")).toBe(0), {
          timeout: 2_000,
        });
        expect(Date.now() - signalAt).toBeLessThan(1_000);
        // The process goes on (a host without process.exit(), the platform
        // not yet at its grace period): a request finishes at signal + 3 s
        // and ingest hangs by then.
        ingest.hangEvents = true;
        await new Promise((resolve) => setTimeout(resolve, 3_000 - (Date.now() - signalAt)));
        await callTool(raw, "get_price", { q: "late" });
        await vi.waitFor(() => expect(ingest.batches).toHaveLength(2));
        const late = ingest.batches[1] as (typeof ingest.batches)[number];
        // Before the fix the cycle was gone, so the budget fell back to D
        // from the send: the socket was held until signal + 7 s, past
        // Fly.io's 5 s, for a host without process.exit().
        await vi.waitFor(() => expect(late.abortedAt).toBeDefined(), { timeout: 8_000 });
        const abortedAfter = (late.abortedAt as number) - signalAt;
        expect(abortedAfter).toBeGreaterThanOrEqual(3_900);
        expect(abortedAfter).toBeLessThan(4_600);
      });
    },
  );

  it("after a first cycle the explicit values of the holds still live count: an explicit 25 s hold, a signal next to an app listener, a second key, a second signal — D is 25 s, the handler's shutdown() is not cut at 4 s", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      const app = () => {};
      process.on("SIGTERM", app); // not the sole listener: the process survives the first cycle
      try {
        ingest.hangEvents = false;
        const { client: x, raw: rawX } = build("yav_148_second_x", { shutdownTimeoutMs: 25_000 });
        await callTool(rawX, "get_price", { q: "x" });
        process.emit("SIGTERM", "SIGTERM");
        await vi.waitFor(() => expect(process.listenerCount("SIGTERM")).toBe(1), {
          timeout: 2_000,
        });
        expect(ingest.responded).toBe(1);
        // X never called shutdown(): its hold, with its 25 s, lives on. A
        // second key acquires — the handlers are installed again — and its
        // call's first batch (the connection event; the tool_call is queued
        // behind it) hangs at ingest until 4.5 s after the next signal, when
        // ingest answers everything.
        ingest.hangEvents = true;
        const { raw: rawY } = build("yav_148_second_y");
        await callTool(rawY, "get_price", { q: "y" });
        await vi.waitFor(() => expect(ingest.batches).toHaveLength(2));
        expect(process.listenerCount("SIGTERM")).toBe(2);
        let answeredOnResolve = false;
        const handled = onSigterm(async () => {
          await x.shutdown();
          answeredOnResolve = ingest.responded === ingest.batches.length;
        });
        const answer = setTimeout(() => {
          ingest.hangEvents = false;
          void ingest.answerHung();
        }, 4_500);
        process.emit("SIGTERM", "SIGTERM");
        try {
          // Before the fix the first drain had cleared the registry and the
          // explicit values with it: the second cycle fell back to 4 s, cut
          // X's shutdown() at signal + 4 s with Y's batch unanswered and
          // counted it lost.
          const { fromSignal } = await handled;
          expect(fromSignal).toBeGreaterThanOrEqual(4_300);
          expect(fromSignal).toBeLessThan(6_000);
          expect(answeredOnResolve).toBe(true);
          expect(ingest.batches[1]?.abortedAt).toBeUndefined();
          expect(warn.mock.calls.map((c: unknown[]) => String(c[0]))).not.toContainEqual(
            expect.stringContaining("YAVIO-1205"),
          );
        } finally {
          clearTimeout(answer);
        }
      } finally {
        process.off("SIGTERM", app);
      }
    });
  }, 15_000);

  it("a hold the signal made stale and a wrap replaced leaves no value behind: an explicit 300 ms client re-wraps after a cycle and shuts down — D is the other client's 3 s again", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      const app = () => {};
      process.on("SIGTERM", app); // not the sole listener: the process survives the cycle
      try {
        ingest.hangEvents = false;
        const { client: a } = build("yav_148_stale_a", { shutdownTimeoutMs: 300 });
        build("yav_148_stale_b", { shutdownTimeoutMs: 3_000 });
        expect(processBudgetMs()).toBe(300);
        process.emit("SIGTERM", "SIGTERM");
        await vi.waitFor(() => expect(process.listenerCount("SIGTERM")).toBe(1), {
          timeout: 2_000,
        });
        // A serves again after the signal: its wrap replaces the stale hold
        // with a new one, which its shutdown() then releases.
        a.wrap(new McpServer({ name: "app", version: "1.0" }));
        await a.shutdown();
        // Before the fix the stale hold's 300 ms stayed registered: D 300.
        expect(processBudgetMs()).toBe(3_000);
      } finally {
        process.off("SIGTERM", app);
      }
    });
  });

  it("YAVIO_SHUTDOWN_TIMEOUT_MS counts even when no participant set a value: a plain client is bounded by it", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      const saved = process.env.YAVIO_SHUTDOWN_TIMEOUT_MS;
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
        restoreEnv("YAVIO_SHUTDOWN_TIMEOUT_MS", saved);
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

  it("with an app handler: the cycle's line counts the drained transports; a late call cut after the deadline gets one more line from the exit hook, in the cycle's wording after a shutdown() the deadline cut, and a plain exit never arms it", async () => {
    _setSignalReraise(() => {});
    await withoutOtherListeners("SIGTERM", async () => {
      const { client, raw } = build("yav_148_exit", { shutdownTimeoutMs: 300 });
      await callTool(raw, "get_price", { q: "x" });
      expect(exitHooks()).toHaveLength(0); // nothing armed: a plain exit prints nothing
      const handled = new Promise<void>((resolve) => {
        process.on("SIGTERM", async function app() {
          process.off("SIGTERM", app);
          // The request finishes at signal + 250 ms and hangs in flight. Its
          // fetch runs within what is left of the cycle, 100 ms at least
          // (review round 3): sent later than signal + D − 100 ms it is cut
          // 50 ms AFTER the deadline, so the cycle's line at the deadline
          // cannot hold it and it is the exit hook's for certain. Sent right
          // at the signal it was cut at the same instant the cycle ended,
          // and which line counted it depended on timer order.
          await new Promise((r) => setTimeout(r, 250));
          await callTool(raw, "get_price", { q: "late" });
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
      // The handler's shutdown() returned at the deadline, so the line is
      // the deadline's, without the hint to await it (#154 review round 1;
      // before: "Process exit with 1 events not delivered — await
      // analytics.shutdown() before exiting").
      exitHooks()[0]?.call(process, 0);
      expect(lines1205()).toHaveLength(2);
      expect(lines1205()[1]).toContain(
        "Shutdown deadline of 300 ms reached — 1 more events not delivered (in flight when the deadline cut it, sent in its last 100 ms",
      );
      expect(lines1205()[1]).not.toContain("await analytics.shutdown()");
      // Written synchronously to fd 2, like the hand-back line: process.exit()
      // ends the process right after its listeners, and an asynchronous
      // stderr pipe would lose a console.warn (#148 review round 3).
      expect(stderr).toHaveBeenCalledWith(
        2,
        expect.stringContaining("1 more events not delivered"),
      );
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("more events not delivered"));
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
      expect(exitHooks()).toHaveLength(1);
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

  it("a cycle handed back early: the batch pre-counted at the hand-back is delivered afterwards, and what later sends lose at the deadline is still printed", async () => {
    // Transport A: five events in flight at the hand-back, answered 300 ms
    // after the signal. Transport B: two events in flight, its fetch
    // ignoring the abort (a fetch that does not honour its signal), so its
    // stop settles 100 ms after the deadline and the cycle's drain with it.
    // Three keys first used after the hand-back: one connection event each
    // in flight, cut at the deadline — losses the hand-back line could not
    // have counted. Before the fix the drain-settled report subtracted the
    // whole pre-count (7) from the losses since (B's 2 and the 3): nothing
    // was printed, `reportedLost` moved past the 3, and the exit hook was
    // quiet too — the 3 were never reported.
    _setSignalReraise(() => {});
    const realFetch = globalThis.fetch;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input: string | URL | Request, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers?.Authorization === "Bearer yav_148_precount_b") {
          return realFetch(input, { ...init, signal: undefined });
        }
        return realFetch(input, init);
      });
    ingest.hangEvents = false;
    ingest.respondAfterMs = (batch) => {
      if (batch.authorization === "Bearer yav_148_precount_a") return 300;
      // B's batch and the late keys' connection batches hang (answered by
      // the mock's close); the late keys' tool_call batches, sent once
      // their connection batch was cut, are answered at once.
      return batch.events.some((e) => e.event_type === "connection") ? 60_000 : 0;
    };
    try {
      await withoutOtherListeners("SIGTERM", async () => {
        await withoutOtherListeners("SIGINT", async () => {
          const { raw: a } = build("yav_148_precount_a", { shutdownTimeoutMs: 600 });
          for (const q of ["1", "2", "3", "4"]) await callTool(a, "get_price", { q });
          const { raw: b } = build("yav_148_precount_b");
          await callTool(b, "get_price", { q: "b" });
          const t0 = Date.now();
          process.emit("SIGTERM", "SIGTERM"); // the drain sends A's 5 and B's 2
          await vi.waitFor(() => expect(ingest.batches).toHaveLength(2));
          process.emit("SIGINT", "SIGINT"); // a different signal: handed back at once
          expect(lines1205()).toHaveLength(1);
          expect(lines1205()[0]).toContain("7 events not delivered");

          // 400 ms after the signal, A delivered: three requests on keys
          // first used now, each through an immediate transport whose fetch
          // runs to the cycle's deadline.
          await new Promise((r) => setTimeout(r, Math.max(0, t0 + 400 - Date.now())));
          expect(ingest.responded).toBe(1);
          for (const key of ["yav_148_precount_x", "yav_148_precount_y", "yav_148_precount_z"]) {
            const { raw: late } = build(key);
            await callTool(late, "get_price", { q: key });
          }
          // The cycle's drain settles at the deadline + 100 ms, when B's
          // ignored abort is given up on: by then the three connection
          // batches were cut at the deadline. One more line, with the
          // three — not B's two, which the hand-back line already counted.
          await vi.waitFor(() => expect(lines1205()).toHaveLength(2), { timeout: 2_000 });
          expect(lines1205()[1]).toContain("Shutdown deadline of 600 ms");
          expect(lines1205()[1]).toContain("3 events not delivered");
          expect(ingest.batches.filter((batch) => batch.abortedAt !== undefined)).toHaveLength(3);
          // The late keys' tool_call batches were answered: nothing pending,
          // nothing left for the exit hook.
          await vi.waitFor(() => expect(ingest.responded).toBe(4));
          expect(exitHooks()).toHaveLength(1);
          exitHooks()[0]?.call(process, 0);
          expect(lines1205()).toHaveLength(2);
        });
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("a cycle handed back early, next to an app listener: the stops' later deadline loss is one line with the cycle's wording", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      await withoutOtherListeners("SIGINT", async () => {
        // The README recipe listens on both signals; a second signal is
        // handed back for the signal that arrived (review round 4), so the
        // SIGINT below is handed back next to the app's listener too.
        const app = vi.fn();
        process.on("SIGTERM", app);
        process.on("SIGINT", app);
        try {
          const { raw } = build("yav_148_late_app", { shutdownTimeoutMs: 600 });
          await callTool(raw, "get_price", { q: "x" });
          process.emit("SIGTERM", "SIGTERM");
          await new Promise((r) => setTimeout(r, 300));
          process.emit("SIGINT", "SIGINT"); // handed back; nothing lost yet, so no line
          expect(app).toHaveBeenCalledTimes(2);
          expect(lines1205()).toHaveLength(0);
          await new Promise((r) => setTimeout(r, 500));
          // The two events the stop gave up at the cycle's deadline, once,
          // as the cycle's — not as a per-transport "shutdown() deadline".
          expect(lines1205()).toHaveLength(1);
          expect(lines1205()[0]).toContain("Shutdown deadline of 600 ms");
          expect(lines1205()[0]).toContain("2 events not delivered");
          expect(lines1205()[0]).not.toContain("shutdown() deadline");
          expect(exitHooks()).toHaveLength(1);
          exitHooks()[0]?.call(process, 0);
          expect(lines1205()).toHaveLength(1); // nothing left unreported
        } finally {
          process.off("SIGTERM", app);
          process.off("SIGINT", app);
        }
      });
    });
  });

  it("a transport stop already in progress at the signal is cut at the cycle's deadline, not at its own: the last holder's 20 s shutdown() against a hanging ingest, then a signal with D = 2 s from another holder — the fetch aborted at signal + 2 s, the loss in the cycle's line", async () => {
    _setSignalReraise(() => {});
    await withoutOtherListeners("SIGTERM", async () => {
      const { client: a, raw: rawA } = build("yav_148_cut_a", { shutdownTimeoutMs: 20_000 });
      await callTool(rawA, "get_price", { q: "a" });
      const { raw: rawB } = build("yav_148_cut_b", { shutdownTimeoutMs: 2_000 });
      await callTool(rawB, "get_price", { q: "b" });
      // A's last holder releases: its transport stops under A's own 20 s,
      // its batch of two in flight against the hanging ingest.
      const closing = a.shutdown();
      await vi.waitFor(() => expect(ingest.batches).toHaveLength(1));
      const inProgress = ingest.batches[0] as (typeof ingest.batches)[number];
      const signalAt = Date.now();
      process.emit("SIGTERM", "SIGTERM"); // D = 2 s: B's explicit value, the smallest
      // Before the fix `shutdown(D)` on A's transport returned the stop
      // already running under its 20 s: nothing aborted its fetch at
      // signal + D, the socket was held 18 s past the process deadline,
      // and its loss was nobody's but the exit hook's.
      await vi.waitFor(() => expect(inProgress.abortedAt).toBeDefined(), { timeout: 5_000 });
      const abortedAfter = (inProgress.abortedAt as number) - signalAt;
      expect(abortedAfter).toBeGreaterThanOrEqual(1_900);
      expect(abortedAfter).toBeLessThan(2_600);
      await closing;
      expect(Date.now() - signalAt).toBeLessThan(2_600);
      await vi.waitFor(() => expect(process.listenerCount("SIGTERM")).toBe(0));
      // One line, the cycle's, with A's two events and B's two — and
      // once both stops have settled under the cycle, still one: A's loss
      // is the cycle's, not a `shutdown()` line of its own.
      expect(lines1205()).toHaveLength(1);
      expect(lines1205()[0]).toContain("Shutdown deadline of 2000 ms");
      expect(lines1205()[0]).toContain("4 events not delivered");
      await vi.waitFor(() => expect(_trackedTransportCount()).toBe(0), { timeout: 2_000 });
      expect(lines1205()).toHaveLength(1);
      expect(lines.some((l) => l.includes("shutdown() deadline"))).toBe(false);
    });
  }, 15_000);

  it("the same next to an app listener: the cycle's line still holds the four events the deadline cuts, whichever of the deadline's timers runs first, and the exit hook has nothing left", async () => {
    // The cycle's deadline timer is created in the same synchronous run as
    // the stops' deadline timers, for the same duration, so it usually runs
    // first: the cycle was handed back before the stops had counted what
    // they gave up. As the only listener the hand-back line pre-counts what
    // is pending; next to an app listener it did not, and before the fix
    // the four events were the exit hook's ("Process exit with 4 events
    // not delivered — await analytics.shutdown() …") or, split by the timer
    // order, half the cycle's and half the exit hook's (#148 review round 9).
    // Since #154 the line comes from `onCycleDeadline`, whichever of the
    // deadline's timers runs first, before the drain's end: the round-10
    // pre-count at "drain-end" finds the stops settled and stays as a
    // safety net for a drain whose wait something else ends early.
    await withoutOtherListeners("SIGTERM", async () => {
      const app = vi.fn();
      process.on("SIGTERM", app);
      try {
        const { client: a, raw: rawA } = build("yav_148_cut_app_a", { shutdownTimeoutMs: 20_000 });
        await callTool(rawA, "get_price", { q: "a" });
        const { raw: rawB } = build("yav_148_cut_app_b", { shutdownTimeoutMs: 2_000 });
        await callTool(rawB, "get_price", { q: "b" });
        // A's last holder releases: its stop runs under A's own 20 s, its
        // batch of two in flight; B's two are queued in the registry.
        const closing = a.shutdown();
        await vi.waitFor(() => expect(ingest.batches).toHaveLength(1));
        const signalAt = Date.now();
        process.emit("SIGTERM", "SIGTERM"); // D = 2 s; the app keeps control
        expect(app).toHaveBeenCalledTimes(1);
        await closing;
        expect(Date.now() - signalAt).toBeLessThan(2_600);
        await vi.waitFor(() => expect(_trackedTransportCount()).toBe(0), { timeout: 3_000 });
        expect(process.listenerCount("SIGTERM")).toBe(1); // the app's; no re-raise
        expect(lines1205()).toHaveLength(1);
        expect(lines1205()[0]).toContain("Shutdown deadline of 2000 ms");
        expect(lines1205()[0]).toContain("4 events not delivered");
        expect(lines.some((l) => l.includes("shutdown() deadline"))).toBe(false);
        // The app exits now: every event was in the cycle's line already.
        expect(exitHooks()).toHaveLength(1);
        exitHooks()[0]?.call(process, 0);
        expect(lines1205()).toHaveLength(1);
      } finally {
        process.off("SIGTERM", app);
      }
    });
  }, 15_000);

  it("and an app that exits right after that line, before the cut stops have settled, gets no second line from the exit hook for the events the line pre-counted", async () => {
    // Fetches that ignore their abort: both stops still hold their batch for
    // ABORT_SETTLE_MS after the deadline, whichever timer ran first, so the
    // exit below always finds the four events pending, not yet counted lost.
    const realFetch = globalThis.fetch;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input: string | URL | Request, init?: RequestInit) =>
        realFetch(input, { ...init, signal: undefined }),
      );
    let lineSeen: () => void = () => {};
    const cycleLine = new Promise<void>((resolve) => {
      lineSeen = resolve;
    });
    warn.mockImplementation((...args: unknown[]) => {
      lines.push(String(args[0]));
      if (String(args[0]).includes("YAVIO-1205")) lineSeen();
    });
    try {
      await withoutOtherListeners("SIGTERM", async () => {
        const app = vi.fn();
        process.on("SIGTERM", app);
        try {
          const { client: a, raw: rawA } = build("yav_148_cut_exit_a", {
            shutdownTimeoutMs: 20_000,
          });
          await callTool(rawA, "get_price", { q: "a" });
          const { raw: rawB } = build("yav_148_cut_exit_b", { shutdownTimeoutMs: 1_000 });
          await callTool(rawB, "get_price", { q: "b" });
          void a.shutdown();
          await vi.waitFor(() => expect(ingest.batches).toHaveLength(1));
          process.emit("SIGTERM", "SIGTERM");
          await Promise.race([cycleLine, new Promise((r) => setTimeout(r, 3_000))]);
          // `process.exit(0)` right after the line, as an app whose own
          // wait the same deadline cut: the stops are still settling.
          expect(_trackedTransportCount()).toBe(2);
          expect(exitHooks()).toHaveLength(1);
          exitHooks()[0]?.call(process, 0);
          expect(lines1205()).toHaveLength(1);
          expect(lines1205()[0]).toContain("Shutdown deadline of 1000 ms");
          expect(lines1205()[0]).toContain("4 events not delivered");
          // Once they have settled, the cycle's late report has nothing to add.
          await vi.waitFor(() => expect(_trackedTransportCount()).toBe(0), { timeout: 2_000 });
          expect(lines1205()).toHaveLength(1);
        } finally {
          process.off("SIGTERM", app);
        }
      });
    } finally {
      fetchSpy.mockRestore();
    }
  }, 15_000);

  it("a cycle handed back early with a stop in progress at the signal, next to an app listener: one cycle line with the four events — at the deadline, a shutdown() still waiting then — and nothing from the exit hook", async () => {
    // The round-6 setup next to an app listener on both signals, and a
    // SIGINT 500 ms after the SIGTERM: a different signal, so the cycle is
    // handed back 1.5 s before its deadline, with nothing lost yet and,
    // next to an app listener, nothing pre-counted. Its stops give up the
    // four events at the deadline, after the hand-back. A's shutdown() is
    // still waiting then, so the cycle's late report comes at the deadline,
    // with the four its stops still hold pre-counted (#154; with no
    // shutdown() waiting it would wait for the stops to settle) — not at
    // the drain's race end: the cycle's timer, made first for the same
    // duration, ends that race before the stops have counted what they give
    // up. Fetches that ignore their abort make that order certain here —
    // both stops hold their batch for ABORT_SETTLE_MS after the deadline —
    // so a report at the race end finds nothing lost, and the four went to
    // the exit hook's "Process exit with 4 events not delivered — await
    // analytics.shutdown() …", a wrong hint for an app that did (#148
    // review round 10, #152).
    const realFetch = globalThis.fetch;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input: string | URL | Request, init?: RequestInit) =>
        realFetch(input, { ...init, signal: undefined }),
      );
    try {
      await withoutOtherListeners("SIGTERM", async () => {
        await withoutOtherListeners("SIGINT", async () => {
          const app = vi.fn();
          process.on("SIGTERM", app);
          process.on("SIGINT", app);
          try {
            const { client: a, raw: rawA } = build("yav_152_early_a", {
              shutdownTimeoutMs: 20_000,
            });
            await callTool(rawA, "get_price", { q: "a" });
            const { raw: rawB } = build("yav_152_early_b", { shutdownTimeoutMs: 2_000 });
            await callTool(rawB, "get_price", { q: "b" });
            // A's last holder releases: its stop runs under A's own 20 s, its
            // batch of two in flight; B's two are queued in the registry.
            const closing = a.shutdown();
            await vi.waitFor(() => expect(ingest.batches).toHaveLength(1));
            process.emit("SIGTERM", "SIGTERM"); // D = 2 s; the drain sends B's two
            await new Promise((r) => setTimeout(r, 500));
            expect(ingest.batches).toHaveLength(2);
            process.emit("SIGINT", "SIGINT"); // handed back, 1.5 s before the deadline
            expect(app).toHaveBeenCalledTimes(2);
            expect(process.listenerCount("SIGINT")).toBe(1); // the app's; no re-raise
            expect(lines1205()).toHaveLength(0); // nothing lost yet, nothing pre-counted
            // Both stops settle at the deadline + ABORT_SETTLE_MS.
            await vi.waitFor(() => expect(_trackedTransportCount()).toBe(0), { timeout: 4_000 });
            await closing;
            expect(lines1205()).toHaveLength(1);
            expect(lines1205()[0]).toContain("Shutdown deadline of 2000 ms");
            expect(lines1205()[0]).toContain("4 events not delivered");
            expect(lines.some((l) => l.includes("shutdown() deadline"))).toBe(false);
            // The app exits now: every event was in the cycle's line already.
            expect(exitHooks()).toHaveLength(1);
            exitHooks()[0]?.call(process, 0);
            expect(lines1205()).toHaveLength(1);
          } finally {
            process.off("SIGTERM", app);
            process.off("SIGINT", app);
          }
        });
      });
    } finally {
      fetchSpy.mockRestore();
    }
  }, 15_000);

  it("the README recipe in one process — an app listener that awaits shutdown() and exits as soon as it returns — against a hanging ingest: the cycle's line is out before shutdown() returns, with every event, a request served after the signal included, and the exit hook adds nothing (#154)", async () => {
    // Before the fix the cycle's deadline timer released the app's wait
    // first: at its return no line was out, and the exit hook's
    // "Process exit with 3 events not delivered — await analytics.shutdown()
    // before exiting" was the only one, a hint for an app that did.
    await withoutOtherListeners("SIGTERM", async () => {
      const { client, raw } = build("yav_154_recipe", { shutdownTimeoutMs: 1_000 });
      await callTool(raw, "get_price", { q: "before" }); // connection + call, queued
      let atReturn: string[] | undefined;
      const app = vi.fn(async () => {
        await client.shutdown();
        atReturn = lines1205();
        exitHooks()[0]?.call(process, 0); // process.exit(0)
      });
      process.on("SIGTERM", app);
      try {
        process.emit("SIGTERM", "SIGTERM"); // D = 1 s; the drain sends the two
        // Served after the signal: its call goes out through a post-signal
        // transport, whose fetch the deadline cuts at the same instant.
        await callTool(raw, "get_price", { q: "after" });
        await vi.waitFor(() => expect(atReturn).toBeDefined(), { timeout: 3_000 });
        expect(atReturn).toHaveLength(1);
        expect(atReturn?.[0]).toContain("Shutdown deadline of 1000 ms reached — 3 events");
        expect(lines1205()).toHaveLength(1);
        expect(lines.some((l) => l.includes("shutdown() deadline"))).toBe(false);
        // Once both fetches were cut — the drain's and the late call's —
        // the cycle's late report has nothing to add.
        await vi.waitFor(() =>
          expect(ingest.batches.filter((b) => b.abortedAt !== undefined)).toHaveLength(2),
        );
        await new Promise((r) => setTimeout(r, 50));
        expect(lines1205()).toHaveLength(1);
      } finally {
        process.off("SIGTERM", app);
      }
    });
  });

  it("the README recipe in one process, two requests served after the signal: what the cycle's line cannot count — the second request's events, queued behind the first's cut batch — comes at exit in the deadline's wording, not with a hint to await shutdown() (#154 review round 1)", async () => {
    // Before the fix: "Process exit with 2 events not delivered — await
    // analytics.shutdown() before exiting", for an app that did.
    await withoutOtherListeners("SIGTERM", async () => {
      const { client, raw } = build("yav_154_recipe2", { shutdownTimeoutMs: 1_000 });
      await callTool(raw, "get_price", { q: "before" }); // connection + call, queued
      let atReturn: string[] | undefined;
      const app = vi.fn(async () => {
        await client.shutdown();
        atReturn = lines1205();
        exitHooks()[0]?.call(process, 0); // process.exit(0)
      });
      process.on("SIGTERM", app);
      try {
        process.emit("SIGTERM", "SIGTERM"); // D = 1 s; the drain sends the two
        // Two calls served after the signal, through one post-signal
        // transport: the first's batch is in flight when the second's
        // events are queued behind it.
        await callTool(raw, "get_price", { q: "after-1" });
        await callTool(raw, "get_price", { q: "after-2" });
        await vi.waitFor(() => expect(atReturn).toBeDefined(), { timeout: 3_000 });
        expect(atReturn).toHaveLength(1);
        expect(atReturn?.[0]).toContain("Shutdown deadline of 1000 ms reached");
        expect(lines1205()).toHaveLength(2);
        expect(lines1205()[1]).toMatch(
          /Shutdown deadline of 1000 ms reached — \d+ more events not delivered \(in flight when the deadline cut it, sent in its last 100 ms or after it, or queued behind a request it cut\)/,
        );
        expect(lines1205().join("\n")).not.toContain("await analytics.shutdown()");
        // Every event once, in one of the two lines: the two before the
        // signal and the first late call's at the deadline, the second late
        // call's — queued behind it, sent once it was cut — at exit.
        const counts = lines1205().map((l) => Number(/(\d+) (more )?events/.exec(l)?.[1]));
        expect(counts).toEqual([3, 1]);
      } finally {
        process.off("SIGTERM", app);
      }
    });
  });

  it("an app that exits before its shutdown() resolved still gets the exit hook's hint to await it", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      const { client, raw } = build("yav_154_noawait", { shutdownTimeoutMs: 1_000 });
      await callTool(raw, "get_price", { q: "x" });
      const app = vi.fn(() => {
        void client.shutdown(); // not awaited
        exitHooks()[0]?.call(process, 0); // process.exit(0) at once
      });
      process.on("SIGTERM", app);
      try {
        process.emit("SIGTERM", "SIGTERM");
        expect(app).toHaveBeenCalledTimes(1);
        expect(lines1205()).toHaveLength(1);
        expect(lines1205()[0]).toContain(
          "Process exit with 2 events not delivered — await analytics.shutdown() before exiting",
        );
      } finally {
        process.off("SIGTERM", app);
      }
    });
  });

  it("a second cycle starts afresh: after the first cycle cut an app's shutdown() — and a late fetch's budget at its deadline — a shutdown() that returns done in the second, then a send not awaited and an exit, gets the hint to await (#154 review rounds 2 and 3)", async () => {
    // Round 2: the first cycle's mark outlived it, "Shutdown deadline of
    // 300 ms reached — 1 more events not delivered (…)" for a second cycle
    // whose deadline was never reached. Round 3: the first cycle's budget
    // cut must not say the second's deadline came — it is before that
    // deadline (`lastBudgetCut >= cycle.deadlineAt`).
    await withoutOtherListeners("SIGTERM", async () => {
      const { client, raw } = build("yav_154_two_cycles", { shutdownTimeoutMs: 300 });
      await callTool(raw, "get_price", { q: "first" });
      let cycles = 0;
      let firstReturned = false;
      let again = raw; // the server the second cycle's requests are served by
      const app = vi.fn(async () => {
        cycles++;
        if (cycles === 1) {
          // Served after the signal: its fetch's budget ends at the deadline.
          await callTool(raw, "get_price", { q: "late" });
          await client.shutdown(); // cut at the 300 ms deadline; the process lives on
          firstReturned = true;
          return;
        }
        await client.shutdown(); // done, well before the second deadline
        ingest.hangEvents = true;
        await callTool(again, "get_price", { q: "unawaited" }); // sent, not awaited
        exitHooks()[0]?.call(process, 0); // process.exit(0)
      });
      process.on("SIGTERM", app);
      try {
        process.emit("SIGTERM", "SIGTERM");
        await vi.waitFor(() => expect(firstReturned).toBe(true), { timeout: 2_000 });
        expect(lines1205()).toHaveLength(1); // the first cycle's line
        // Both of the first cycle's batches were cut at its deadline: the
        // drain's by the stop's deadline, the late call's by its budget.
        await vi.waitFor(() =>
          expect(ingest.batches.filter((b) => b.abortedAt !== undefined)).toHaveLength(2),
        );
        await ingest.answerHung();
        ingest.hangEvents = false; // healthy for the second cycle
        // A request served later wraps again — the SDK's listeners come back.
        again = client.wrap(new McpServer({ name: "app", version: "1.0" }));
        again.registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
        await callTool(again, "get_price", { q: "second" });
        process.emit("SIGTERM", "SIGTERM");
        expect(cycles).toBe(2);
        await vi.waitFor(() => expect(lines1205()).toHaveLength(2), { timeout: 2_000 });
        expect(lines1205()[1]).toContain("Process exit with");
        expect(lines1205()[1]).toContain("await analytics.shutdown() before exiting");
      } finally {
        process.off("SIGTERM", app);
      }
    });
  });

  it("a cycle that ended early and healthy, a later request's batch still in flight when its deadline comes: the app's shutdown() released by the cycle's timer, the exit line is the deadline's — not \"more\", no hint to await (#154 review round 2)", async () => {
    // The late batch's fetch ignores its abort, so no loss is counted when
    // the deadline cuts it: the only sign that the deadline came is the
    // cycle's timer, which also releases the app's wait. Without that sign
    // the line is "Process exit with 1 events not delivered — await
    // analytics.shutdown() …" for an app that did.
    const realFetch = globalThis.fetch;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input: string | URL | Request, init?: RequestInit) =>
        realFetch(input, { ...init, signal: undefined }),
      );
    ingest.hangEvents = false; // healthy at the signal
    try {
      await withoutOtherListeners("SIGTERM", async () => {
        const { client, raw } = build("yav_154_healthy_late", { shutdownTimeoutMs: 1_000 });
        await callTool(raw, "get_price", { q: "before" });
        let atExit: string[] | undefined;
        const app = vi.fn(async () => {
          await new Promise((r) => setTimeout(r, 300)); // the drain delivers meanwhile
          ingest.hangEvents = true; // hanging from now on
          await callTool(raw, "get_price", { q: "late" }); // in flight at the deadline
          await client.shutdown(); // released by the cycle's timer at the deadline
          exitHooks()[0]?.call(process, 0); // process.exit(0)
          atExit = lines1205();
        });
        process.on("SIGTERM", app);
        try {
          process.emit("SIGTERM", "SIGTERM");
          await vi.waitFor(() => expect(atExit).toBeDefined(), { timeout: 3_000 });
          expect(ingest.responded).toBe(1); // the drain's batch
          expect(atExit).toEqual([
            `[YAVIO-1205] Shutdown deadline of 1000 ms reached — 1 events not delivered (in flight when the deadline cut it, sent in its last 100 ms or after it, or queued behind a request it cut). Raise shutdownTimeoutMs (or YAVIO_SHUTDOWN_TIMEOUT_MS) if the platform's grace period allows.`,
          ]);
        } finally {
          process.off("SIGTERM", app);
        }
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("the same when the late fetch's budget timer runs before the cycle's: the app's wait settles at the cut and it exits before the cycle's timer — the budget cut is what says the deadline came (#154 review round 3)", async () => {
    // The order the cycle's own timer cannot be relied on to precede: here
    // forced by giving that timer (the first one of the cycle's duration
    // set while the signal is handled) 300 ms more. The budget timer then
    // aborts the late fetch at the deadline, the app's shutdown() settles
    // and it exits with nothing else to tell it the deadline came. Without
    // the budget cut's record the line is "Process exit with 1 events not
    // delivered — await analytics.shutdown() …".
    ingest.hangEvents = false; // healthy at the signal
    await withoutOtherListeners("SIGTERM", async () => {
      const { client, raw } = build("yav_154_budget_first", { shutdownTimeoutMs: 1_000 });
      await callTool(raw, "get_price", { q: "before" });
      let atExit: string[] | undefined;
      const app = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 300)); // the drain delivers meanwhile
        ingest.hangEvents = true;
        await callTool(raw, "get_price", { q: "late" }); // its fetch's budget ends at the deadline
        await client.shutdown(); // settles when the budget cuts that fetch
        exitHooks()[0]?.call(process, 0); // process.exit(0) at once
        atExit = lines1205();
      });
      process.on("SIGTERM", app);
      const realSetTimeout = globalThis.setTimeout;
      let delayed = false;
      const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        fn: (...args: unknown[]) => void,
        ms?: number,
        ...rest: unknown[]
      ) => {
        if (!delayed && ms === 1_000) {
          delayed = true; // the cycle's timer
          return realSetTimeout(fn, 1_300, ...rest);
        }
        return realSetTimeout(fn, ms, ...rest);
      }) as typeof setTimeout);
      try {
        process.emit("SIGTERM", "SIGTERM");
        timers.mockRestore();
        expect(delayed).toBe(true);
        await vi.waitFor(() => expect(atExit).toBeDefined(), { timeout: 3_000 });
        expect(atExit).toEqual([
          `[YAVIO-1205] Shutdown deadline of 1000 ms reached — 1 events not delivered (in flight when the deadline cut it, sent in its last 100 ms or after it, or queued behind a request it cut). Raise shutdownTimeoutMs (or YAVIO_SHUTDOWN_TIMEOUT_MS) if the platform's grace period allows.`,
        ]);
        // The cycle's timer had not run when the app exited.
        await new Promise((r) => setTimeout(r, 400));
      } finally {
        timers.mockRestore();
        process.off("SIGTERM", app);
      }
    });
  });

  it("several waits end at one cycle deadline — two apps' shutdown() timers and the cycle's — and the cycle prints one line (#154 review round 1)", async () => {
    // Each of the three runs onCycleDeadline at the same deadline; once per
    // cycle. Here a second call would count nothing — what the first line
    // marked is reconciled, the post-signal fetches are flagged — so a
    // mutant dropping the guard survives this test, which pins the outcome.
    // The guard is not redundant: triggers at one deadline need not run in
    // one tick (timers start from the loop's cached time), and a send in
    // the deadline's last 100 ms cut between two of them, while a stop that
    // ignores its abort is still settling, would without it be a second
    // cycle line instead of the exit line (each event still counted once;
    // #154 review round 2).
    await withoutOtherListeners("SIGTERM", async () => {
      const a = build("yav_154_two_a", { shutdownTimeoutMs: 800 });
      const b = build("yav_154_two_b", { shutdownTimeoutMs: 800 });
      await callTool(a.raw, "get_price", { q: "a" });
      await callTool(b.raw, "get_price", { q: "b" });
      const returned: string[][] = [];
      const app = vi.fn(async () => {
        await Promise.all(
          [a.client, b.client].map((client) =>
            client.shutdown().then(() => {
              returned.push(lines1205());
            }),
          ),
        );
      });
      process.on("SIGTERM", app);
      try {
        process.emit("SIGTERM", "SIGTERM");
        await vi.waitFor(() => expect(returned).toHaveLength(2), { timeout: 3_000 });
        expect(returned.map((l) => l.length)).toEqual([1, 1]);
        expect(lines1205()[0]).toContain("Shutdown deadline of 800 ms reached — 4 events");
        await vi.waitFor(() => expect(_trackedTransportCount()).toBe(0), { timeout: 2_000 });
        await new Promise((r) => setTimeout(r, 50));
        expect(lines1205()).toHaveLength(1);
        expect(exitHooks()).toHaveLength(1);
        exitHooks()[0]?.call(process, 0);
        expect(lines1205()).toHaveLength(1);
      } finally {
        process.off("SIGTERM", app);
      }
    });
  });

  it("a test reset while a shutdown() waits leaves the count of waits at 0, not -1 (#154 review round 1)", async () => {
    // The reset zeroes the count and releases the wait; before the fix the
    // wait's own decrement then ran too. A negative count would read as no
    // shutdown() waiting in the next test's cycle.
    const { client, raw } = build("yav_154_waits", { shutdownTimeoutMs: 2_000 });
    await callTool(raw, "get_price", { q: "a" });
    const closing = client.shutdown(); // the hanging ingest keeps it waiting
    expect(_appWaitCount()).toBe(1);
    _resetGlobalState();
    await closing;
    expect(_appWaitCount()).toBe(0);
    // The released stop goes on in the background: let it deliver, or its
    // own deadline prints a shutdown() line into a later test.
    await vi.waitFor(() => expect(ingest.batches).toHaveLength(1));
    await ingest.answerHung();
    await vi.waitFor(() => expect(ingest.responded).toBe(1));
  });

  describe("one late line per cycle, whichever deadline timer runs first (#154, CI)", () => {
    // D = 600 ms from B's explicit value; B's fetch ignores its abort, so its
    // stop settles at the deadline + ABORT_SETTLE_MS. A second signal hands
    // the cycle back at once. X sends before the deadline's last 100 ms (the
    // deadline cuts its fetch); Y sends within them, so the 100 ms floor
    // cuts its fetch after the deadline, before B settles. Connection
    // batches hang; the tool_call batch behind each is answered at once.
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      const realFetch = globalThis.fetch;
      fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation((input: string | URL | Request, init?: RequestInit) => {
          const headers = init?.headers as Record<string, string> | undefined;
          if (headers?.Authorization === "Bearer yav_154_once_b") {
            return realFetch(input, { ...init, signal: undefined });
          }
          return realFetch(input, init);
        });
      ingest.hangEvents = false;
      ingest.respondAfterMs = (batch) =>
        batch.events.some((e) => e.event_type === "connection") ? 60_000 : 0;
    });
    afterEach(() => fetchSpy.mockRestore());

    const sentAt = (key: string) =>
      ingest.batches.find((batch) => batch.authorization === `Bearer ${key}`)?.receivedAt ?? 0;
    const cycleLines = () => lines1205().filter((l) => l.includes("Shutdown deadline"));

    /** X right away, Y at t0 + 530 ms; both sends checked against the deadline's last 100 ms. */
    async function lateSends(t0: number): Promise<void> {
      const { raw: x } = build("yav_154_once_x");
      await callTool(x, "get_price", { q: "x" });
      await new Promise((r) => setTimeout(r, Math.max(0, t0 + 530 - Date.now())));
      const { raw: y } = build("yav_154_once_y");
      await callTool(y, "get_price", { q: "y" });
      await vi.waitFor(() => expect(sentAt("yav_154_once_y")).toBeGreaterThan(0));
      expect(sentAt("yav_154_once_x")).toBeGreaterThan(0);
      expect(sentAt("yav_154_once_x")).toBeLessThan(t0 + 500);
      expect(sentAt("yav_154_once_y")).toBeGreaterThan(t0 + 510);
      expect(sentAt("yav_154_once_y")).toBeLessThan(t0 + 600);
    }

    it("no shutdown() waiting: nothing is released at the deadline, so the late report waits for the stops — one line with what the deadline and the floor cut", async () => {
      // Before the fix the cycle's timer printed a late line at the deadline
      // whether or not anything was waiting on it — X's one event — and the
      // stops' settling printed a second with Y's: three lines in all, and
      // in CI, where the test then reached the exit hook within the tool
      // call responses, one more from the exit hook.
      _setSignalReraise(() => {});
      await withoutOtherListeners("SIGTERM", async () => {
        await withoutOtherListeners("SIGINT", async () => {
          const { raw: b } = build("yav_154_once_b", { shutdownTimeoutMs: 600 });
          await callTool(b, "get_price", { q: "b" });
          const t0 = Date.now();
          process.emit("SIGTERM", "SIGTERM"); // the drain sends B's two
          await vi.waitFor(() => expect(ingest.batches).toHaveLength(1));
          process.emit("SIGINT", "SIGINT"); // handed back at once, B's two pre-counted
          expect(lines1205()).toHaveLength(1);
          expect(lines1205()[0]).toContain("2 events not delivered");
          await lateSends(t0);
          await vi.waitFor(() => expect(_trackedTransportCount()).toBe(2), { timeout: 2_000 }); // B settled
          await new Promise((r) => setTimeout(r, 100));
          expect(lines1205(), lines1205().join("\n")).toHaveLength(2);
          expect(lines1205()[1]).toContain("Shutdown deadline of 600 ms");
          expect(lines1205()[1]).toContain("2 events not delivered"); // X and Y
        });
      });
    });

    it("an app's shutdown() waiting: the late line comes at the deadline, before it returns, and stays the cycle's only one — Y, lost after it, is the exit hook's, in the deadline's wording", async () => {
      // Before the fix the stops' settling printed a second late line with
      // Y's event after the one at the deadline.
      await withoutOtherListeners("SIGTERM", async () => {
        await withoutOtherListeners("SIGINT", async () => {
          const { client, raw: b } = build("yav_154_once_b", { shutdownTimeoutMs: 600 });
          await callTool(b, "get_price", { q: "b" });
          let closing: Promise<void> | undefined;
          let atReturn: string[] | undefined;
          const app = vi.fn(() => {
            closing ??= client.shutdown().then(() => {
              atReturn = cycleLines();
            });
          });
          process.on("SIGTERM", app);
          process.on("SIGINT", app);
          try {
            const t0 = Date.now();
            process.emit("SIGTERM", "SIGTERM"); // the app's shutdown() waits for the drain
            await vi.waitFor(() => expect(ingest.batches).toHaveLength(1));
            process.emit("SIGINT", "SIGINT"); // handed back at once, nothing pre-counted
            expect(lines1205()).toHaveLength(0);
            await lateSends(t0);
            await closing;
            expect(atReturn).toHaveLength(1);
            expect(atReturn?.[0]).toContain("Shutdown deadline of 600 ms reached — 3 events"); // B's two and X
            await vi.waitFor(() => expect(_trackedTransportCount()).toBe(2), { timeout: 2_000 }); // B settled
            await new Promise((r) => setTimeout(r, 100));
            expect(cycleLines(), lines1205().join("\n")).toHaveLength(1);
            expect(exitHooks()).toHaveLength(1);
            exitHooks()[0]?.call(process, 0);
            expect(lines1205()).toHaveLength(2);
            // Y, in the deadline's wording: the app's shutdown() returned at
            // it (#154 review round 1; before: "Process exit with 1 events
            // not delivered — await analytics.shutdown() …").
            expect(lines1205()[1]).toContain(
              "Shutdown deadline of 600 ms reached — 1 more events not delivered",
            );
            expect(lines1205()[1]).not.toContain("await analytics.shutdown()");
          } finally {
            process.off("SIGTERM", app);
            process.off("SIGINT", app);
          }
        });
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
    expect(exitHooks()).toHaveLength(1);
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

/**
 * The natural exit (#167): Node emits `beforeExit` once the loop has
 * emptied — a stdio server whose client closed stdin, a script that never
 * called `shutdown()`, a host that closed its server without a signal. The
 * SDK stops every live transport there under min(1.5 s, D), so what is
 * queued is delivered before the process goes. Before #167 nothing listened
 * and the queue went with the process, without a line.
 */
describe("the natural exit: beforeExit with events queued (#167)", () => {
  let ingest: MockIngest;
  let warn: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;
  let lines: string[];
  const lines1205 = () => lines.filter((l) => l.includes("YAVIO-1205"));
  const exitHooks = () => process.listeners("exit").filter((l) => l.name === "yavioReportAtExit");
  const sdkBeforeExit = () =>
    process.listeners("beforeExit").filter((l) => l.name === "onBeforeExit");
  /** What Node does when the loop empties, for the SDK's listener only (vitest may have its own). */
  const emitBeforeExit = () => {
    for (const listener of sdkBeforeExit()) listener.call(process, 0);
  };

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
    ingest = await startMockIngest({ respondAfterMs: 50 });
  });

  afterEach(async () => {
    await ingest.answerHung();
    _resetGlobalState();
    warn.mockRestore();
    stderr.mockRestore();
    await ingest.close();
  });

  it("one listener per process, installed with the first transport; the test reset removes it", () => {
    expect(sdkBeforeExit()).toHaveLength(0);
    build("yav_167_a");
    build("yav_167_b");
    withYavio(new McpServer({ name: "app", version: "1.0" }), {
      apiKey: "yav_167_c",
      endpoint: ingest.endpoint,
      serverOnly: true,
    });
    expect(sdkBeforeExit()).toHaveLength(1);
    _resetGlobalState();
    expect(sdkBeforeExit()).toHaveLength(0);
  });

  it("delivers what is queued, once: the pass Node emits again while the drain runs, and the one after it, add nothing", async () => {
    const { raw } = build("yav_167_once");
    await callTool(raw, "get_price", { q: "x" });
    expect(ingest.events).toHaveLength(0); // buffered: the flush interval is 10 s
    emitBeforeExit();
    emitBeforeExit(); // re-entry while the stop runs
    expect(_sharedStateCount()).toBe(0); // the registry was stopped and emptied
    await vi.waitFor(() => expect(_trackedTransportCount()).toBe(0)); // the stop settled
    emitBeforeExit(); // what Node emits after the drain settled
    await new Promise((r) => setTimeout(r, 100));
    expect(ingest.batches).toHaveLength(1);
    expect(ingest.events.map((e) => e.event_type)).toEqual(["connection", "tool_call"]);
    expect(lines1205()).toEqual([]);
    exitHooks()[0]?.call(process, 0); // armed by the drain; nothing left to report
    expect(lines1205()).toEqual([]);
  });

  it("with nothing queued: returns at once — nothing stopped, nothing armed, nothing printed", async () => {
    build("yav_167_idle");
    emitBeforeExit();
    expect(_sharedStateCount()).toBe(1);
    expect(exitHooks()).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(ingest.batches).toHaveLength(0);
    expect(lines1205()).toEqual([]);
  });

  it("a shutdown() called while the drain runs (an app's own beforeExit listener) waits for it", async () => {
    ingest.respondAfterMs = 300;
    const { client, raw } = build("yav_167_join");
    await callTool(raw, "get_price", { q: "x" });
    emitBeforeExit();
    const t = Date.now();
    await client.shutdown();
    expect(Date.now() - t).toBeGreaterThanOrEqual(250);
    expect(ingest.responded).toBe(1);
    expect(ingest.batches).toHaveLength(1); // one drain, no second send
  });

  it.each([
    ["no option: 1.5 s", undefined, 1_500],
    ["a lower shutdownTimeoutMs: its own", 600, 600],
    ["a higher shutdownTimeoutMs does not raise it", 10_000, 1_500],
  ] as const)(
    "bounded by min(1.5 s, D) — %s; the deadline's loss is one exit line in the natural wording",
    async (_label, own, boundMs) => {
      ingest.hangEvents = true;
      const { raw } = build("yav_167_bound", own === undefined ? {} : { shutdownTimeoutMs: own });
      await callTool(raw, "get_price", { q: "x" });
      const t = Date.now();
      emitBeforeExit();
      await vi.waitFor(() => expect(_trackedTransportCount()).toBe(0), {
        timeout: 3_000,
        interval: 10,
      });
      const took = Date.now() - t;
      expect(took).toBeGreaterThanOrEqual(boundMs - 20);
      expect(took).toBeLessThan(boundMs + 300);
      // Not a `shutdown() deadline` line: nobody called shutdown().
      expect(lines1205()).toEqual([]);
      exitHooks()[0]?.call(process, 0);
      expect(lines1205()).toEqual([
        `[YAVIO-1205] Exit deadline of ${boundMs} ms reached — 2 events not delivered (the process ended on its own with events queued; queued, in flight or refused after the deadline). To wait longer, await analytics.shutdown() before the event loop empties (on stdin's end or at the end of the script; a beforeExit listener is too late).`,
      ]);
    },
  );

  it("a signal during the drain takes over its stops and does not extend them: the cycle ends at the natural deadline, one line", async () => {
    const reraisedSignals: string[] = [];
    _setSignalReraise((signal) => reraisedSignals.push(signal));
    ingest.hangEvents = true;
    await withoutOtherListeners("SIGTERM", async () => {
      const { raw } = build("yav_167_signal");
      await callTool(raw, "get_price", { q: "x" });
      const t = Date.now();
      emitBeforeExit(); // natural deadline at t + 1.5 s
      await new Promise((r) => setTimeout(r, 500));
      process.emit("SIGTERM", "SIGTERM"); // D = 4 s would end at t + 4.5 s
      await vi.waitFor(() => expect(reraisedSignals).toEqual(["SIGTERM"]), {
        timeout: 6_000,
        interval: 10,
      });
      const took = Date.now() - t;
      expect(took).toBeGreaterThanOrEqual(1_480);
      expect(took).toBeLessThan(1_900);
      expect(lines1205()).toHaveLength(1); // the cycle's
      // It names D, not the natural deadline that did the cut: the known
      // limitation of #167 (the count is right).
      expect(lines1205()[0]).toContain(
        "Shutdown deadline of 4000 ms reached — 2 events not delivered",
      );
      exitHooks()[0]?.call(process, 0); // nothing left for the exit hook
      expect(lines1205()).toHaveLength(1);
    });
  });

  it("an exit before the drain's stops settled (an app's process.exit() during it) is not its deadline's: the exit line keeps the Process exit wording", async () => {
    ingest.hangEvents = true;
    const { raw } = build("yav_167_early");
    await callTool(raw, "get_price", { q: "x" });
    emitBeforeExit(); // the natural deadline 1.5 s ahead
    await vi.waitFor(() => expect(ingest.batches).toHaveLength(1));
    exitHooks()[0]?.call(process, 0);
    expect(lines1205()).toEqual([
      "[YAVIO-1205] Process exit with 2 events not delivered — await analytics.shutdown() before exiting, or raise shutdownTimeoutMs.",
    ]);
  });

  it("0.5.4's workaround — an app beforeExit listener registered after createYavio() that calls shutdown() — waits only for the SDK's 1.5 s drain, whatever its own shutdownTimeoutMs; the line says a beforeExit listener is too late (review round 1)", async () => {
    ingest.respondAfterMs = 2_500; // answers after the natural bound, within the client's own 10 s
    const { client, raw } = build("yav_167_workaround", { shutdownTimeoutMs: 10_000 });
    await callTool(raw, "get_price", { q: "x" });
    const t = Date.now();
    emitBeforeExit(); // the SDK's listener runs first: it was installed by createYavio()
    await client.shutdown(); // the workaround's call, in the app's listener after it
    const took = Date.now() - t;
    expect(took).toBeGreaterThanOrEqual(1_480);
    expect(took).toBeLessThan(2_200);
    await vi.waitFor(() => expect(_trackedTransportCount()).toBe(0));
    exitHooks()[0]?.call(process, 0);
    expect(lines1205()).toEqual([
      "[YAVIO-1205] Exit deadline of 1500 ms reached — 2 events not delivered (the process ended on its own with events queued; queued, in flight or refused after the deadline). To wait longer, await analytics.shutdown() before the event loop empties (on stdin's end or at the end of the script; a beforeExit listener is too late).",
    ]);
  });

  /** A server with one tool, wrapped by either entry point: what a later send goes through is the proxy it already has. */
  function wrapped(entry: "createYavio().wrap()" | "withYavio()", apiKey: string): McpServer {
    if (entry === "createYavio().wrap()") return build(apiKey).raw;
    const raw = new McpServer({ name: "app", version: "1.0" });
    withYavio(raw, { apiKey, endpoint: ingest.endpoint, serverOnly: true }).registerTool(
      "get_price",
      { inputSchema: { q: z.string() } },
      ok,
    );
    return raw;
  }
  const qs = (batch: { events: Array<Record<string, unknown>> } | undefined) =>
    (batch?.events ?? []).map(
      (e) => (e.input_values as { q?: string } | undefined)?.q ?? e.event_type,
    );

  it.each(["createYavio().wrap()", "withYavio()"] as const)(
    "the process goes on after the drain, round after round (an app's beforeExit listener schedules more work; Lambda's Node 20/22 client answers a callback handler from beforeExit after every invocation) — %s: each round's sends through the same proxy re-enter the registry, and the next beforeExit delivers them (review round 1)",
    async (entry) => {
      const raw = wrapped(entry, "yav_167_late");
      await callTool(raw, "get_price", { q: "first" });
      emitBeforeExit();
      await vi.waitFor(() => expect(_trackedTransportCount()).toBe(0)); // the drain settled
      expect(qs(ingest.batches[0])).toEqual(["connection", "first"]);
      expect(_sharedStateCount()).toBe(0);

      // drain → late sends → drain → late sends → drain: every round delivered.
      for (const round of [1, 2, 3]) {
        await callTool(raw, "get_price", { q: `late${round}a` }); // dropped without a line before review round 1
        await callTool(raw, "get_price", { q: `late${round}b` });
        expect(_sharedStateCount()).toBe(1); // re-entered, with a fresh transport
        expect(_trackedTransportCount()).toBe(1);
        expect(ingest.batches).toHaveLength(round); // queued: the flush interval is 10 s
        emitBeforeExit(); // what Node emits once the late work has settled
        await vi.waitFor(() => expect(ingest.batches).toHaveLength(round + 1));
        expect(qs(ingest.batches[round])).toEqual([`late${round}a`, `late${round}b`]);
        await vi.waitFor(() => expect(_trackedTransportCount()).toBe(0));
        expect(_sharedStateCount()).toBe(0); // drained again: the next round re-enters again
      }
      expect(ingest.ofType("tool_call")).toHaveLength(7);
      exitHooks()[0]?.call(process, 0);
      expect(lines1205()).toEqual([]);
    },
  );

  it("a send while the drain still runs (an unref'd timer of the app's fires while the drain holds the loop) goes through a fresh transport, which the next beforeExit drains (review round 1)", async () => {
    ingest.respondAfterMs = 300;
    const { raw } = build("yav_167_during");
    await callTool(raw, "get_price", { q: "first" });
    emitBeforeExit();
    await vi.waitFor(() => expect(ingest.batches).toHaveLength(1)); // the drain's batch is out
    await callTool(raw, "get_price", { q: "during" });
    expect(_sharedStateCount()).toBe(1);
    await vi.waitFor(() => expect(ingest.responded).toBe(1)); // the first drain's batch answered
    emitBeforeExit();
    await vi.waitFor(() => expect(ingest.responded).toBe(2));
    expect(qs(ingest.batches[1])).toEqual(["during"]);
    await vi.waitFor(() => expect(_trackedTransportCount()).toBe(0));
    exitHooks()[0]?.call(process, 0);
    expect(lines1205()).toEqual([]);
  });

  it("only a natural drain makes a later send re-enter: after a re-acquire and the last holder's release, a send is dropped as before (review round 1)", async () => {
    const { client, raw } = build("yav_167_released");
    await callTool(raw, "get_price", { q: "first" });
    emitBeforeExit();
    await vi.waitFor(() => expect(_trackedTransportCount()).toBe(0));
    client.wrap(new McpServer({ name: "again", version: "1.0" })); // re-acquires the key
    expect(_sharedStateCount()).toBe(1);
    await client.shutdown(); // the last holder releases: the transport stops
    expect(_sharedStateCount()).toBe(0);
    await callTool(raw, "get_price", { q: "after release" });
    expect(_sharedStateCount()).toBe(0); // nowhere to go, as with any stopped transport
    expect(_trackedTransportCount()).toBe(0);
  });

  it("the drain took a client's hold, then the client's shutdown() releases it: a send after that is dropped, as after any last release (review round 2)", async () => {
    const { client, raw } = build("yav_167_r2_a");
    await callTool(raw, "get_price", { q: "first" });
    emitBeforeExit();
    await vi.waitFor(() => expect(_trackedTransportCount()).toBe(0));
    await client.shutdown(); // its hold went with the drain: the release counts on the drained entry
    await callTool(raw, "get_price", { q: "after shutdown" }); // re-entered and delivered in round 1
    expect(_sharedStateCount()).toBe(0);
    expect(_trackedTransportCount()).toBe(0);
    emitBeforeExit();
    await new Promise((r) => setTimeout(r, 100));
    expect(ingest.ofType("tool_call").map((e) => (e.input_values as { q: string }).q)).toEqual([
      "first",
    ]);
  });

  it("after a re-entry, a client's shutdown() against a hanging ingest stops the transport at its own deadline — the fetch aborted, its shutdown() line — not a drain that leaves the fetch running (review round 2)", async () => {
    const { client, raw } = build("yav_167_r2_c", { shutdownTimeoutMs: 600 });
    await callTool(raw, "get_price", { q: "first" });
    emitBeforeExit();
    await vi.waitFor(() => expect(_trackedTransportCount()).toBe(0));
    await callTool(raw, "get_price", { q: "re-entered" });
    expect(_sharedStateCount()).toBe(1);
    ingest.hangEvents = true;
    const t = Date.now();
    await client.shutdown();
    const took = Date.now() - t;
    expect(took).toBeGreaterThanOrEqual(580);
    expect(took).toBeLessThan(1_100);
    // Released and stopped: before round 2 the stale hold only drained, the
    // registry kept the SDK's pin and the hanging fetch kept its socket.
    expect(_sharedStateCount()).toBe(0);
    await vi.waitFor(() => expect(_trackedTransportCount()).toBe(0));
    expect(lines1205()).toEqual([
      "[YAVIO-1205] shutdown() deadline of 600 ms reached — 1 events not delivered. Raise shutdownTimeoutMs (or YAVIO_SHUTDOWN_TIMEOUT_MS) if the platform's grace period allows.",
    ]);
    exitHooks()[0]?.call(process, 0); // nothing left for the exit hook
    expect(lines1205()).toHaveLength(1);
  });

  const toolCallQs = () =>
    ingest.ofType("tool_call").map((e) => (e.input_values as { q: string }).q);

  it("two createYavio() clients on one key: after the drain one re-wraps and shuts down, and the other's later calls are still delivered — the re-wrap put the drained entry back (review round 3)", async () => {
    const a = build("yav_167_r3_two");
    const b = build("yav_167_r3_two");
    await callTool(a.raw, "get_price", { q: "a1" });
    await callTool(b.raw, "get_price", { q: "b1" });
    emitBeforeExit();
    await vi.waitFor(() => expect(_trackedTransportCount()).toBe(0));
    a.client.wrap(new McpServer({ name: "a2", version: "1.0" })); // a re-acquire
    await callTool(b.raw, "get_price", { q: "b2" });
    await a.client.shutdown(); // a releases; b still holds
    // Before round 3: a's wrap made a new entry, a's shutdown() stopped it,
    // and b's hold — on the drained entry — was stale: b3 was dropped.
    expect(_sharedStateCount()).toBe(1);
    await callTool(b.raw, "get_price", { q: "b3" });
    emitBeforeExit();
    await vi.waitFor(() => expect(toolCallQs()).toEqual(["a1", "b1", "b2", "b3"]));
    await vi.waitFor(() => expect(_trackedTransportCount()).toBe(0));
    // No phantom holder: a's hold was revived, not taken twice, so b's
    // shutdown() is the last release and stops the transport.
    await callTool(b.raw, "get_price", { q: "b4" });
    await b.client.shutdown();
    expect(_sharedStateCount()).toBe(0);
    expect(toolCallQs()).toEqual(["a1", "b1", "b2", "b3", "b4"]);
    expect(lines1205()).toEqual([]);
  });

  it("a client created after the drain shuts down, and the older client's later calls are still delivered — createYavio() put the drained entry back (review round 3)", async () => {
    const a = build("yav_167_r3_late_client");
    await callTool(a.raw, "get_price", { q: "a1" });
    emitBeforeExit();
    await vi.waitFor(() => expect(_trackedTransportCount()).toBe(0));
    const late = build("yav_167_r3_late_client"); // createYavio() takes a hold
    expect(_sharedStateCount()).toBe(1);
    await late.client.shutdown(); // the late client releases; a still holds
    // Before round 3: the late client's hold was on a new entry, its
    // shutdown() stopped it, and a's later calls vanished without a line.
    expect(_sharedStateCount()).toBe(1);
    await callTool(a.raw, "get_price", { q: "a2" });
    emitBeforeExit();
    await vi.waitFor(() => expect(toolCallQs()).toEqual(["a1", "a2"]));
    await vi.waitFor(() => expect(_trackedTransportCount()).toBe(0));
    await a.client.shutdown(); // a's hold, revived by the send: the last release
    expect(_sharedStateCount()).toBe(0);
    // The second drain already emptied the registry, so the count above proves
    // nothing about the release; a send after it does: the last release drops
    // the drained mark, so the key is not put back and the call is not sent.
    await callTool(a.raw, "get_price", { q: "a3" });
    emitBeforeExit();
    await new Promise((r) => setTimeout(r, 50));
    expect(toolCallQs()).toEqual(["a1", "a2"]);
    expect(_sharedStateCount()).toBe(0);
    expect(lines1205()).toEqual([]);
  });

  it.each(["createYavio().wrap()", "withYavio()"] as const)(
    "100 rounds of drain → send → drain accumulate nothing — %s: at most one registry entry and one transport, one beforeExit listener, D unchanged, every event once (review round 2)",
    async (entry) => {
      ingest.respondAfterMs = 0; // 100 round trips
      const raw = wrapped(entry, "yav_167_r2_rounds");
      const sdkListeners = () => sdkBeforeExit().length;
      const budget = processBudgetMs();
      for (let round = 1; round <= 100; round++) {
        await callTool(raw, "get_price", { q: `r${round}` });
        expect(_sharedStateCount()).toBe(1);
        expect(_trackedTransportCount()).toBe(1);
        emitBeforeExit();
        await vi.waitFor(() => expect(_trackedTransportCount()).toBe(0), { interval: 2 });
        expect(_sharedStateCount()).toBe(0);
      }
      expect(sdkListeners()).toBe(1);
      expect(processBudgetMs()).toBe(budget);
      const qsDelivered = ingest
        .ofType("tool_call")
        .map((e) => (e.input_values as { q: string }).q);
      expect(qsDelivered).toEqual(Array.from({ length: 100 }, (_, i) => `r${i + 1}`));
      const ids = ingest.events.map((e) => e.event_id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ingest.batches).toHaveLength(100);
      exitHooks()[0]?.call(process, 0);
      expect(lines1205()).toEqual([]);
    },
    20_000,
  );
});

describe("a SIGTERM after the cycle's SIGINT: a client's stop sequence (#175)", () => {
  // Claude Code 2.1.310 (macOS, Linux) stops a stdio server with SIGINT, a
  // SIGTERM 100 ms later and a SIGKILL 400 ms after that. Before #175 the
  // SIGTERM handed the drain back at once, about 100 ms in.
  let ingest: MockIngest;
  let warn: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;
  let lines: string[];
  /** What the SDK re-raised: the signal, ms after `t0` (the SIGINT), and the event batches ingest had answered by then. */
  let reraised: Array<{ signal: string; at: number; answered: number }>;
  let t0 = 0;
  const lines1205 = () => lines.filter((l) => l.includes("YAVIO-1205"));
  const exitHooks = () => process.listeners("exit").filter((l) => l.name === "yavioReportAtExit");
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const CLIENT_HINT =
    "The client stops the server with SIGINT, SIGTERM and SIGKILL (Claude Code: 100 ms, then 400 ms); a higher shutdownTimeoutMs does not extend that.";
  const BOUND_LINE =
    /^\[YAVIO-1205\] Shutdown deadline of 400 ms \(SIGTERM (\d+) ms after SIGINT\) reached — (\d+) events not delivered \(queued, in flight or refused after the deadline\)\. /;

  /** The SDK the only listener on both signals: a stdio server with no handler of its own. */
  const alone = (fn: () => Promise<void>) =>
    withoutOtherListeners("SIGINT", () => withoutOtherListeners("SIGTERM", fn));

  /** A `withYavio()` server, called once: two events queued (connection, tool_call). */
  async function pinned(apiKey: string, options: { shutdownTimeoutMs?: number } = {}) {
    const raw = new McpServer({ name: "app", version: "1.0" });
    withYavio(raw, {
      apiKey,
      endpoint: ingest.endpoint,
      serverOnly: true,
      ...options,
    }).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
    await callTool(raw, "get_price", { q: "x" });
    return raw;
  }

  /**
   * Emit `signal` with the clock pinned at `t0 + ms`: the cycle's decisions
   * read `Date.now()` when the signal arrives, so the rules are tested at
   * exact offsets, independent of how late a timer fires on a loaded host.
   */
  function emitAt(ms: number, signal: "SIGINT" | "SIGTERM"): void {
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0 + ms);
    try {
      process.emit(signal, signal);
    } finally {
      clock.mockRestore();
    }
  }

  beforeEach(async () => {
    _resetGlobalState();
    lines = [];
    reraised = [];
    _setSignalReraise((signal) =>
      reraised.push({ signal, at: Date.now() - t0, answered: ingest.responded }),
    );
    warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(String(args[0]));
    });
    stderr = spyStderr(lines);
    ingest = await startMockIngest();
  });

  afterEach(async () => {
    await ingest.answerHung();
    _resetGlobalState();
    warn.mockRestore();
    stderr.mockRestore();
    vi.restoreAllMocks(); // the clock and transport spies a failed assertion left behind
    await ingest.close();
  });

  it("SIGINT, then SIGTERM 100 ms later, ingest answering at SIGINT + 200 ms: nothing is handed back at the SIGTERM; the batch is answered, then the SIGTERM is re-raised before SIGINT + 400 ms, with no line", async () => {
    await alone(async () => {
      await pinned("yav_175_deliver");
      // Answered after the SIGTERM and well before the bound, wherever the
      // batch's receipt falls.
      ingest.respondAfterMs = (batch) => Math.max(0, t0 + 200 - batch.receivedAt);
      t0 = Date.now();
      process.emit("SIGINT", "SIGINT");
      await sleep(100);
      process.emit("SIGTERM", "SIGTERM");
      // Before #175: [{ signal: "SIGTERM", at: ~100, answered: 0 }] here.
      expect(reraised).toEqual([]);
      await vi.waitFor(() => expect(reraised).toHaveLength(1), { timeout: 2_000 });
      expect(reraised[0]).toMatchObject({ signal: "SIGTERM", answered: 1 });
      expect(reraised[0]?.at).toBeGreaterThanOrEqual(195);
      expect(reraised[0]?.at).toBeLessThan(400);
      expect(ingest.batches.map((b) => b.abortedAt)).toEqual([undefined]);
      expect(lines1205()).toEqual([]);
    });
  });

  it("against a hanging ingest: handed back at SIGINT + 400 ms, the stop's fetch aborted there, one line that names that bound and drops the hint to raise shutdownTimeoutMs", async () => {
    await alone(async () => {
      ingest.hangEvents = true;
      await pinned("yav_175_hang");
      t0 = Date.now();
      process.emit("SIGINT", "SIGINT");
      await sleep(100);
      process.emit("SIGTERM", "SIGTERM");
      await vi.waitFor(() => expect(reraised).toHaveLength(1), { timeout: 2_000 });
      expect(reraised[0]?.signal).toBe("SIGTERM");
      // Before #175: at the SIGTERM, about 100 ms in.
      expect(reraised[0]?.at).toBeGreaterThanOrEqual(395);
      expect(reraised[0]?.at).toBeLessThan(1_000);
      expect(lines1205()).toHaveLength(1);
      const [line] = lines1205() as [string];
      const [, sigtermAfter, lost] = BOUND_LINE.exec(line) ?? [];
      expect(line, line).toMatch(BOUND_LINE);
      expect(Number(sigtermAfter)).toBeGreaterThanOrEqual(95);
      expect(Number(sigtermAfter)).toBeLessThan(400);
      expect(Number(lost)).toBe(2);
      expect(line.endsWith(CLIENT_HINT)).toBe(true);
      expect(line).not.toContain("Raise shutdownTimeoutMs");
      // Cut to the bound (`cutDeadline`), not left to run to D = 4 s.
      await vi.waitFor(() => expect(ingest.batches[0]?.abortedAt).toBeDefined(), {
        timeout: 1_000,
      });
      expect((ingest.batches[0]?.abortedAt as number) - t0).toBeLessThan(1_000);
    });
  });

  it("the bound counts from the SIGINT, never from the SIGTERM: a SIGTERM at SIGINT + 200 ms still ends the cycle at SIGINT + 400 ms", async () => {
    await alone(async () => {
      ingest.hangEvents = true;
      await pinned("yav_175_anchor");
      t0 = Date.now();
      emitAt(0, "SIGINT");
      emitAt(200, "SIGTERM");
      expect(reraised).toEqual([]);
      await vi.waitFor(() => expect(reraised).toHaveLength(1), { timeout: 2_000 });
      expect(lines1205()).toEqual([
        expect.stringMatching(
          /^\[YAVIO-1205\] Shutdown deadline of 400 ms \(SIGTERM 200 ms after SIGINT\) reached — 2 events not delivered/,
        ),
      ]);
    });
  });

  it("a loop blocked through both signals handles them back to back: the bound is then 300 ms after the SIGTERM — Claude Code's SIGKILL comes 400 ms after it — not SIGINT + 400 ms (review round 1)", async () => {
    await alone(async () => {
      ingest.hangEvents = true;
      await pinned("yav_175_blocked");
      t0 = Date.now();
      // Both pending when the loop frees up: the SIGINT handled late, the
      // SIGTERM 5 ms after it.
      emitAt(0, "SIGINT");
      emitAt(5, "SIGTERM");
      expect(reraised).toEqual([]);
      await vi.waitFor(() => expect(reraised).toHaveLength(1), { timeout: 2_000 });
      expect(reraised[0]?.at).toBeGreaterThanOrEqual(295);
      expect(lines1205()).toEqual([
        expect.stringMatching(
          /^\[YAVIO-1205\] Shutdown deadline of 305 ms \(SIGTERM 5 ms after SIGINT\) reached — 2 events not delivered/,
        ),
      ]);
    });
  });

  it("a third signal hands back at once: SIGINT, SIGTERM at +100 ms, SIGINT at +150 ms", async () => {
    await alone(async () => {
      ingest.hangEvents = true;
      await pinned("yav_175_third");
      t0 = Date.now();
      emitAt(0, "SIGINT");
      emitAt(100, "SIGTERM");
      expect(reraised).toEqual([]); // before #175: [{ signal: "SIGTERM", at: 100, … }]
      emitAt(150, "SIGINT"); // an impatient Ctrl-C still ends it
      expect(reraised).toEqual([{ signal: "SIGINT", at: 150, answered: 0 }]);
    });
  });

  it("after the SIGTERM, a repeat of it within 250 ms of its arrival is the same delivery; one after that hands back at once", async () => {
    await alone(async () => {
      ingest.hangEvents = true;
      await pinned("yav_175_repeat");
      t0 = Date.now();
      emitAt(0, "SIGINT");
      emitAt(100, "SIGTERM");
      emitAt(340, "SIGTERM"); // 240 ms after the SIGTERM's arrival (340 after the SIGINT): one delivery, twice
      expect(reraised).toEqual([]);
      emitAt(360, "SIGTERM"); // 260 ms after it: a new delivery
      expect(reraised).toEqual([{ signal: "SIGTERM", at: 360, answered: 0 }]);
    });
  });

  it("guard: a SIGTERM at SIGINT + 400 ms or later hands back at once, as before #175", async () => {
    await alone(async () => {
      ingest.hangEvents = true;
      await pinned("yav_175_late", { shutdownTimeoutMs: 2_000 });
      t0 = Date.now();
      emitAt(0, "SIGINT");
      emitAt(400, "SIGTERM");
      expect(reraised).toEqual([{ signal: "SIGTERM", at: 400, answered: 0 }]);
    });
  });

  it("guard: SIGTERM, then SIGINT 100 ms later, hands back at once — only the SIGINT → SIGTERM order is a stop sequence (decision E)", async () => {
    await alone(async () => {
      ingest.hangEvents = true;
      await pinned("yav_175_order");
      t0 = Date.now();
      emitAt(0, "SIGTERM");
      emitAt(100, "SIGINT");
      expect(reraised).toEqual([{ signal: "SIGINT", at: 100, answered: 0 }]);
    });
  });

  it("an app that handles only SIGTERM: the escalated SIGTERM is handed back with its own decision — the SIGINT found the SDK alone, the SIGTERM does not — so nothing is re-raised at the bound and the app keeps control (#148 review round 4)", async () => {
    await alone(async () => {
      const app = vi.fn();
      process.on("SIGTERM", app);
      try {
        ingest.hangEvents = true;
        await pinned("yav_175_sigterm_app");
        t0 = Date.now();
        process.emit("SIGINT", "SIGINT"); // the SDK alone: Node's default would end the process
        await sleep(100);
        process.emit("SIGTERM", "SIGTERM"); // the app's own signal
        expect(app).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(lines1205()).toHaveLength(1), { timeout: 2_000 }); // the bound came
        await sleep(50);
        // With the SIGINT's decision kept, the SIGTERM was re-raised here and
        // its default action killed the app in the middle of its shutdown.
        expect(reraised).toEqual([]);
        expect(lines1205()[0]).toMatch(BOUND_LINE);
      } finally {
        process.off("SIGTERM", app);
      }
    });
  });

  it("an app that handles only SIGINT: the escalated SIGTERM, which only the SDK listens to, is re-raised at the bound", async () => {
    await alone(async () => {
      const app = vi.fn();
      process.on("SIGINT", app);
      try {
        ingest.hangEvents = true;
        await pinned("yav_175_sigint_app");
        t0 = Date.now();
        process.emit("SIGINT", "SIGINT"); // the app's own signal: no re-raise for it
        await sleep(100);
        process.emit("SIGTERM", "SIGTERM"); // nothing else listens: Node's default must run
        await vi.waitFor(() => expect(reraised).toHaveLength(1), { timeout: 2_000 });
        expect(reraised[0]?.signal).toBe("SIGTERM");
        expect(reraised[0]?.at).toBeGreaterThanOrEqual(395);
      } finally {
        process.off("SIGINT", app);
      }
    });
  });

  it("a lower explicit shutdownTimeoutMs is not extended: D = 250 ms hands the SIGTERM back at SIGINT + 250 ms, with D's wording and hint", async () => {
    await alone(async () => {
      ingest.hangEvents = true;
      await pinned("yav_175_lower", { shutdownTimeoutMs: 250 });
      t0 = Date.now();
      process.emit("SIGINT", "SIGINT");
      await sleep(100);
      process.emit("SIGTERM", "SIGTERM");
      expect(reraised).toEqual([]); // before #175: handed back here
      await vi.waitFor(() => expect(reraised).toHaveLength(1), { timeout: 2_000 });
      expect(reraised[0]?.signal).toBe("SIGTERM");
      expect(reraised[0]?.at).toBeGreaterThanOrEqual(245);
      expect(reraised[0]?.at).toBeLessThan(1_000);
      expect(lines1205()).toEqual([
        "[YAVIO-1205] Shutdown deadline of 250 ms reached — 2 events not delivered (queued, in flight or refused after the deadline). Raise shutdownTimeoutMs (or YAVIO_SHUTDOWN_TIMEOUT_MS) if the platform's grace period allows.",
      ]);
    });
  });

  it("next to the app's own handler on both signals: its shutdown() returns at SIGINT + 400 ms, after the cycle's one line, and nothing is re-raised", async () => {
    await alone(async () => {
      ingest.hangEvents = true;
      const analytics = createYavio({
        apiKey: "yav_175_app",
        endpoint: ingest.endpoint,
        serverOnly: true,
      });
      const raw = new McpServer({ name: "app", version: "1.0" });
      analytics.wrap(raw).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
      await callTool(raw, "get_price", { q: "x" });
      let returnedAt: number | undefined;
      let linesAtReturn = -1;
      let stopping: Promise<void> | undefined;
      const stop = () => {
        stopping ??= analytics.shutdown().then(() => {
          returnedAt = Date.now() - t0;
          linesAtReturn = lines1205().length;
        });
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      try {
        t0 = Date.now();
        process.emit("SIGINT", "SIGINT");
        await sleep(100);
        process.emit("SIGTERM", "SIGTERM");
        await vi.waitFor(() => expect(returnedAt).toBeDefined(), { timeout: 5_000 });
        // Before #175 the SIGTERM handed back at once and the app's
        // shutdown() waited for the 4 s deadline: under Claude Code the
        // SIGKILL at 500 ms came first, without a line.
        expect(returnedAt).toBeGreaterThanOrEqual(395);
        expect(returnedAt).toBeLessThan(1_500);
        expect(linesAtReturn).toBe(1);
        expect(lines1205()[0]).toMatch(BOUND_LINE);
        expect(reraised).toEqual([]);
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    });
  });

  it("a flush() during the cycle ends at the bound too, not at its own flushTimeoutMs", async () => {
    await alone(async () => {
      ingest.hangEvents = true;
      const analytics = createYavio({
        apiKey: "yav_175_flush",
        endpoint: ingest.endpoint,
        serverOnly: true,
        flushTimeoutMs: 2_000,
      });
      const raw = new McpServer({ name: "app", version: "1.0" });
      analytics.wrap(raw).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
      await callTool(raw, "get_price", { q: "x" });
      t0 = Date.now();
      process.emit("SIGINT", "SIGINT");
      const flushed = analytics.flush().then(() => Date.now() - t0);
      await sleep(100);
      process.emit("SIGTERM", "SIGTERM");
      const took = await flushed;
      // Before #175: the SIGTERM handed back at once, and the flush waited
      // for its own 2 s.
      expect(took).toBeGreaterThanOrEqual(395);
      expect(took).toBeLessThan(1_500);
    });
  });

  it("a request served after the SIGTERM sends through a post-signal transport whose fetch is cut at the bound, not at SIGINT + D", async () => {
    await alone(async () => {
      ingest.hangEvents = true;
      const raw = await pinned("yav_175_late_fetch");
      t0 = Date.now();
      process.emit("SIGINT", "SIGINT");
      await sleep(100);
      process.emit("SIGTERM", "SIGTERM");
      await sleep(50);
      await callTool(raw, "get_price", { q: "late" }); // sent at once, one attempt
      await vi.waitFor(() => expect(ingest.batches).toHaveLength(2));
      // Before #175 the hand-back at the SIGTERM left SIGINT + 4 s as the
      // last deadline, and the late fetch ran until then.
      await vi.waitFor(() => expect(ingest.batches[1]?.abortedAt).toBeDefined(), {
        timeout: 2_000,
      });
      const abortedAfter = (ingest.batches[1]?.abortedAt as number) - t0;
      expect(abortedAfter).toBeGreaterThanOrEqual(395);
      expect(abortedAfter).toBeLessThan(1_000);
    });
  });

  it("the README recipe next to an escalated cycle: what the line cannot count — a second late request's events, queued behind the first's cut batch — comes at exit in the bound's wording, not D's", async () => {
    await alone(async () => {
      ingest.hangEvents = true;
      const client = createYavio({
        apiKey: "yav_175_exit",
        endpoint: ingest.endpoint,
        serverOnly: true,
      });
      const raw = new McpServer({ name: "app", version: "1.0" });
      client.wrap(raw).registerTool("get_price", { inputSchema: { q: z.string() } }, ok);
      await callTool(raw, "get_price", { q: "before" }); // connection + call, queued
      let atReturn: string[] | undefined;
      let stopping: Promise<void> | undefined;
      const app = () => {
        stopping ??= (async () => {
          await client.shutdown();
          atReturn = lines1205();
          exitHooks()[0]?.call(process, 0); // process.exit(0)
        })();
      };
      process.on("SIGINT", app);
      process.on("SIGTERM", app);
      try {
        t0 = Date.now();
        process.emit("SIGINT", "SIGINT");
        await sleep(100);
        process.emit("SIGTERM", "SIGTERM");
        // Two calls served after the SIGTERM, through one post-signal
        // transport: the first's batch in flight, its fetch bounded by
        // SIGINT + 400 ms, the second's events queued behind it.
        await callTool(raw, "get_price", { q: "after-1" });
        await callTool(raw, "get_price", { q: "after-2" });
        await vi.waitFor(() => expect(atReturn).toBeDefined(), { timeout: 5_000 });
        expect(atReturn).toEqual([expect.stringMatching(BOUND_LINE)]);
        expect(lines1205()).toHaveLength(2);
        expect(lines1205()[1]).toMatch(
          /^\[YAVIO-1205\] Shutdown deadline of 400 ms \(SIGTERM \d+ ms after SIGINT\) reached — 1 more events not delivered \(in flight when the deadline cut it, sent in its last 100 ms or after it, or queued behind a request it cut\)\. /,
        );
        expect(lines1205()[1]?.endsWith(CLIENT_HINT)).toBe(true);
        expect(lines1205().join("\n")).not.toContain("Raise shutdownTimeoutMs");
        const counts = lines1205().map((l) => Number(/(\d+) (more )?events/.exec(l)?.[1]));
        expect(counts).toEqual([3, 1]);
      } finally {
        process.off("SIGINT", app);
        process.off("SIGTERM", app);
      }
    });
  });
});

describe("the last client's shutdown() on a key withYavio() pinned (#179)", () => {
  let ingest: MockIngest;
  let warn: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;
  let lines: string[];
  const lines1205 = () => lines.filter((l) => l.includes("YAVIO-1205"));
  const exitHooks = () => process.listeners("exit").filter((l) => l.name === "yavioReportAtExit");
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const toolCallQs = () =>
    ingest.ofType("tool_call").map((e) => (e.input_values as { q: string }).q);
  /** What Node does when the loop empties, for the SDK's listener only (vitest may have its own). */
  const emitBeforeExit = () => {
    for (const listener of process.listeners("beforeExit")) {
      if (listener.name === "onBeforeExit") listener.call(process, 0);
    }
  };

  /** The README's shape: a `withYavio()` server — the pin — and a shutdown-only `createYavio()` client for the same key. */
  function setup(apiKey: string, shutdownTimeoutMs = 300) {
    const analytics = createYavio({
      apiKey,
      endpoint: ingest.endpoint,
      serverOnly: true,
      shutdownTimeoutMs,
    });
    const raw = new McpServer({ name: "app", version: "1.0" });
    withYavio(raw, { apiKey, endpoint: ingest.endpoint, serverOnly: true }).registerTool(
      "get_price",
      { inputSchema: { q: z.string() } },
      ok,
    );
    return { analytics, raw };
  }

  beforeEach(async () => {
    _resetGlobalState();
    _setSignalReraise(() => {});
    lines = [];
    warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(String(args[0]));
    });
    stderr = spyStderr(lines);
    ingest = await startMockIngest();
  });

  afterEach(async () => {
    await ingest.answerHung();
    _resetGlobalState();
    warn.mockRestore();
    stderr.mockRestore();
    vi.restoreAllMocks(); // the transport spies a failed assertion left behind
    await ingest.close();
  });

  it("against a hanging ingest: shutdown() stops the transport at its own deadline — the fetch aborted, one shutdown() line — and the exit hook adds nothing", async () => {
    const { analytics, raw } = setup("yav_179_hang");
    await callTool(raw, "get_price", { q: "x" });
    ingest.hangEvents = true;
    const t = Date.now();
    await analytics.shutdown();
    const took = Date.now() - t;
    expect(took).toBeGreaterThanOrEqual(280);
    expect(took).toBeLessThan(1_000);
    // Before #179: [] — a drain's deadline only stops waiting.
    expect(lines1205()).toEqual([
      "[YAVIO-1205] shutdown() deadline of 300 ms reached — 2 events not delivered. Raise shutdownTimeoutMs (or YAVIO_SHUTDOWN_TIMEOUT_MS) if the platform's grace period allows.",
    ]);
    await vi.waitFor(() => expect(ingest.batches[0]?.abortedAt).toBeDefined(), { timeout: 1_000 });
    expect(_sharedStateCount()).toBe(1); // the pin keeps its entry, with a fresh transport
    // Before #179: "Process exit with 2 events not delivered — await analytics.shutdown() …"
    exitHooks()[0]?.call(process, 0);
    expect(lines1205()).toHaveLength(1);
  });

  it("the README recipe: a call through the pin that finishes during the client's shutdown() joins that stop and is delivered by it, and the process.exit(0) after it has nothing to report (review round 1)", async () => {
    const { analytics, raw } = setup("yav_179_during", 1_500);
    ingest.respondAfterMs = 200;
    await callTool(raw, "get_price", { q: "before" });
    const stopping = analytics.shutdown();
    await sleep(50); // the stop's batch is in flight
    await callTool(raw, "get_price", { q: "during" });
    await stopping;
    // As before #179, when it joined the drain. Round 1's first version sent
    // it to the fresh transport: ["before"] here, and the exit hook's
    // "Process exit with 1 events not delivered — await analytics.shutdown() …".
    expect(toolCallQs()).toEqual(["before", "during"]);
    expect(ingest.responded).toBe(2);
    exitHooks()[0]?.call(process, 0); // process.exit(0)
    expect(lines1205()).toEqual([]);
  });

  it("against a hanging ingest, a call that joined the stop is counted once, in the stop's shutdown() line, and the exit hook adds nothing", async () => {
    const { analytics, raw } = setup("yav_179_during_hang");
    await callTool(raw, "get_price", { q: "before" });
    ingest.hangEvents = true;
    const stopping = analytics.shutdown();
    await sleep(50);
    await callTool(raw, "get_price", { q: "during" }); // queued behind the hanging batch
    await stopping;
    await vi.waitFor(() => expect(lines1205()).toHaveLength(1), { timeout: 1_000 });
    expect(lines1205()).toEqual([
      "[YAVIO-1205] shutdown() deadline of 300 ms reached — 3 events not delivered. Raise shutdownTimeoutMs (or YAVIO_SHUTDOWN_TIMEOUT_MS) if the platform's grace period allows.",
    ]);
    expect(ingest.batches).toHaveLength(1);
    exitHooks()[0]?.call(process, 0);
    expect(lines1205()).toHaveLength(1);
  });

  it("once the stop is over, a call through the pin goes through the fresh transport, and the next client's shutdown() delivers it", async () => {
    const { analytics, raw } = setup("yav_179_after", 2_000);
    await callTool(raw, "get_price", { q: "before" });
    await analytics.shutdown();
    await callTool(raw, "get_price", { q: "after" });
    expect(toolCallQs()).toEqual(["before"]); // queued on the fresh transport
    await createYavio({
      apiKey: "yav_179_after",
      endpoint: ingest.endpoint,
      serverOnly: true,
    }).shutdown();
    expect(toolCallQs()).toEqual(["before", "after"]);
  });

  it("with a second client still holding the key, the first's shutdown() only drains; the second's stops the transport", async () => {
    const { analytics, raw } = setup("yav_179_two");
    const other = createYavio({
      apiKey: "yav_179_two",
      endpoint: ingest.endpoint,
      serverOnly: true,
    });
    await callTool(raw, "get_price", { q: "x" });
    const shutdowns = vi.spyOn(HttpTransport.prototype, "shutdown");
    await analytics.shutdown();
    expect(shutdowns).not.toHaveBeenCalled();
    expect(toolCallQs()).toEqual(["x"]); // drained: delivered
    await other.shutdown();
    expect(shutdowns).toHaveBeenCalledTimes(1); // before #179: 0
    expect(_sharedStateCount()).toBe(1);
  });

  it("after a natural-exit drain took the pinned entry and a send put it back, the client's shutdown() stops the restored transport: the fetch aborted, its shutdown() line (#167)", async () => {
    const { analytics, raw } = setup("yav_179_natural", 600);
    await callTool(raw, "get_price", { q: "first" });
    emitBeforeExit();
    await vi.waitFor(() => expect(_trackedTransportCount()).toBe(0));
    await callTool(raw, "get_price", { q: "re-entered" }); // the entry goes back, holds and pin live again
    expect(_sharedStateCount()).toBe(1);
    ingest.hangEvents = true;
    const t = Date.now();
    await analytics.shutdown();
    const took = Date.now() - t;
    expect(took).toBeGreaterThanOrEqual(580);
    expect(took).toBeLessThan(1_100);
    // Before #179 the restored pinned entry was only drained: no line. And
    // until the #178 follow-up the release awaited the long-settled natural
    // drain, so the stop's line came a few milliseconds after shutdown()
    // returned: the app's process.exit(0) printed the exit hook's instead.
    expect(lines1205()).toEqual([
      "[YAVIO-1205] shutdown() deadline of 600 ms reached — 1 events not delivered. Raise shutdownTimeoutMs (or YAVIO_SHUTDOWN_TIMEOUT_MS) if the platform's grace period allows.",
    ]);
    await vi.waitFor(() => expect(ingest.batches[1]?.abortedAt).toBeDefined(), { timeout: 1_000 });
    expect(_sharedStateCount()).toBe(1);
    exitHooks()[0]?.call(process, 0);
    expect(lines1205()).toHaveLength(1);
  });

  it("a shutdown() called while the natural-exit drain still runs, on an entry a send put back: it waits for the drain, its stop's deadline counts from the call, and the stop's line comes before shutdown() returns (#178 follow-up)", async () => {
    const { analytics, raw } = setup("yav_178_running", 600);
    // The drain's batch is answered after 300 ms; every later one hangs.
    ingest.respondAfterMs = () => {
      ingest.hangEvents = true; // read before this delay: every later batch hangs
      return 300;
    };
    await callTool(raw, "get_price", { q: "first" });
    emitBeforeExit(); // the natural-exit drain: 300 ms
    await callTool(raw, "get_price", { q: "re-entered" }); // puts the entry back, holds and pin live
    const t = Date.now();
    await analytics.shutdown();
    const took = Date.now() - t;
    const atReturn = lines1205();
    // Before: the stop got its 600 ms from the drain's end, about 900 ms
    // after the call, so shutdown() returned at 600 ms with no line yet.
    // Now its deadline is 600 ms from the call less ABORT_SETTLE_MS (100):
    // the stop settles, and shutdown() returns, at about 500 ms.
    expect(took).toBeGreaterThanOrEqual(480);
    expect(took).toBeLessThan(1_000);
    expect(atReturn).toEqual([
      expect.stringMatching(
        /^\[YAVIO-1205\] shutdown\(\) deadline of \d+ ms reached — 1 events not delivered\./,
      ),
    ]);
    exitHooks()[0]?.call(process, 0);
    expect(lines1205()).toHaveLength(1);
  });

  it("guard: a flush() during the pinned stop waits for that stop, then flushes the fresh transport (#171)", async () => {
    const { analytics, raw } = setup("yav_179_flush", 2_000);
    // The stop's batch is answered late, everything after it at once.
    ingest.respondAfterMs = (batch) => (ingest.batches.indexOf(batch) === 0 ? 300 : 0);
    await callTool(raw, "get_price", { q: "before" });
    const stopping = analytics.shutdown();
    await sleep(50);
    await callTool(raw, "get_price", { q: "during" }); // joins the stop
    await analytics.flush();
    // Both answered when the flush returns: it awaited the key's stop.
    expect(ingest.responded).toBe(2);
    expect(toolCallQs()).toEqual(["before", "during"]);
    await stopping;
    await callTool(raw, "get_price", { q: "after" }); // the fresh transport
    await analytics.flush();
    expect(toolCallQs()).toEqual(["before", "during", "after"]);
  });

  it("a signal during the pinned stop takes it over and cuts it to the cycle's deadline, with what the pin sent meanwhile joined to it, and stops the fresh transport too — every event once, in the cycle's one line, no shutdown() line", async () => {
    await withoutOtherListeners("SIGTERM", async () => {
      ingest.hangEvents = true;
      const { analytics, raw } = setup("yav_179_signal", 20_000);
      // A second pin on the key with an explicit 1 s: D at the signal.
      withYavio(new McpServer({ name: "app2", version: "1.0" }), {
        apiKey: "yav_179_signal",
        endpoint: ingest.endpoint,
        serverOnly: true,
        shutdownTimeoutMs: 1_000,
      });
      await callTool(raw, "get_price", { q: "before" });
      const t = Date.now();
      const stopping = analytics.shutdown(); // its own 20 s
      await sleep(50);
      await callTool(raw, "get_price", { q: "during" }); // joins the stop, behind its batch
      process.emit("SIGTERM", "SIGTERM");
      await stopping;
      const took = Date.now() - t;
      expect(took).toBeGreaterThanOrEqual(1_000);
      expect(took).toBeLessThan(2_500);
      // The stop's batch, cut at signal + D; "during" given up with it.
      await vi.waitFor(() => expect(ingest.batches[0]?.abortedAt).toBeDefined());
      expect((ingest.batches[0]?.abortedAt as number) - t).toBeLessThan(2_500);
      expect(ingest.batches).toHaveLength(1);
      // The cycle took the registry, the fresh transport with it, and both
      // transports have settled.
      expect(_sharedStateCount()).toBe(0);
      await vi.waitFor(() => expect(_trackedTransportCount()).toBe(0));
      expect(lines1205()).toEqual([
        expect.stringMatching(/^\[YAVIO-1205\] Shutdown deadline of 1000 ms reached — 3 events/),
      ]);
      exitHooks()[0]?.call(process, 0);
      expect(lines1205()).toHaveLength(1);
    });
  });
});
