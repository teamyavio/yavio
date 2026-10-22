/**
 * The README's graceful-shutdown recipe in a real process (#142, #148): a
 * stateless host as a child, 50 calls from one conversation over a
 * keep-alive client, then a real signal — with nothing in flight,
 * or with one request still being served. Before 0.5.2 the app's `await
 * shutdown()` resolved in 3 ms with the drain still running and
 * `process.exit(0)` lost every event. Before 0.5.3 the recipe's unbounded
 * `http.close()` waited for the keep-alive socket, the deadline was 10 s and
 * ran from the handler's own call, so a hanging ingest took the process to
 * 15–18 s after the signal — past every platform's grace period but
 * Kubernetes' — and a refusing one kept it alive for 31 s without an exit
 * of its own. Asserted here on MCP SDK v1 and v2 against a mock ingest that
 * answers 150 ms late, hangs, or refuses.
 *
 * The child runs the SDK's source through tsx (`node --import tsx`), on
 * whichever MCP SDK versions the lockfile or the compat matrix installed.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { Agent, request } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MockIngest, refusedEndpoint, startMockIngest } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "stateless-host.ts");
/** packages/sdk — `--import tsx` resolves from the working directory. */
const SDK_DIR = join(here, "..", "..", "..");
const UA = "openai-mcp/1.0.0";
const PROTOCOL = "2025-06-18";
const STACKS = ["v1", "v2"] as const;
type Stack = (typeof STACKS)[number];
type Mode = "readme" | "none" | "noexit";

/** The events a run produces before the signal: 50 calls, one connection, two discoveries. */
const EVENTS_BEFORE_SIGNAL = 53;

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Milliseconds from the signal to the exit event. */
  afterSignalMs: number;
  /** The ingest's counters the moment the child exited: what it waited for before it went. */
  atExit: { responded: number; batches: number };
}

interface Child {
  proc: ChildProcess;
  port: number;
  output: () => string;
  exited: Promise<Exit>;
  /** Send the signal and remember when: `exited` measures from here. */
  kill: (signal: NodeJS.Signals) => void;
  /** `Date.now()` of `kill`. */
  signalAt: () => number;
  /** Resolve once the child's output matches, or reject when it exits first. */
  waitForOutput: (pattern: RegExp, timeoutMs?: number) => Promise<void>;
  /** The `YAVIO-1205` lines the child printed, as their event counts. */
  lossLines: () => number[];
}

interface StartOptions {
  stack: Stack;
  mode: Mode;
  endpoint: string;
  env?: Record<string, string>;
  /** Counters read at the exit event. */
  counters: () => { responded: number; batches: number };
}

async function startChild(
  options: StartOptions,
  onSpawn: (proc: ChildProcess) => void,
): Promise<Child> {
  const proc = spawn(process.execPath, ["--import", "tsx", FIXTURE], {
    cwd: SDK_DIR,
    env: {
      ...process.env,
      ENDPOINT: options.endpoint,
      STACK: options.stack,
      MODE: options.mode,
      YAVIO_API_KEY: "",
      YAVIO_ENDPOINT: "",
      YAVIO_SHUTDOWN_TIMEOUT_MS: "",
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Handed out before anything can throw, so cleanup can reach a child
  // that never became ready.
  onSpawn(proc);
  let out = "";
  proc.stdout?.on("data", (chunk) => {
    out += chunk;
  });
  proc.stderr?.on("data", (chunk) => {
    out += chunk;
  });
  let signalAt = 0;
  const exited = new Promise<Exit>((resolve) =>
    proc.on("exit", (code, signal) =>
      resolve({
        code,
        signal,
        afterSignalMs: Date.now() - signalAt,
        atExit: options.counters(),
      }),
    ),
  );
  const waitForOutput = (pattern: RegExp, timeoutMs = 30_000) =>
    new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error(`child output never matched ${pattern}:\n${out}`)),
        timeoutMs,
      );
      const poll = setInterval(() => {
        if (pattern.test(out)) {
          clearInterval(poll);
          clearTimeout(deadline);
          resolve();
        }
      }, 20);
      void exited.then(() => {
        clearInterval(poll);
        clearTimeout(deadline);
        reject(new Error(`child exited before its output matched ${pattern}:\n${out}`));
      });
    });
  await waitForOutput(/ready \d+/);
  const port = Number((out.match(/ready (\d+)/) as RegExpMatchArray)[1]);
  return {
    proc,
    port,
    output: () => out,
    exited,
    kill: (signal) => {
      signalAt = Date.now();
      proc.kill(signal);
    },
    signalAt: () => signalAt,
    waitForOutput,
    lossLines: () =>
      [...out.matchAll(/YAVIO-1205\][^\n]*?(\d+) events not delivered/g)].map((m) => Number(m[1])),
  };
}

let rpcId = 0;

/** The JSON-RPC result of a response body: JSON, or the last `data:` line of an SSE stream (v2). */
function parseBody(text: string): unknown {
  if (text.startsWith("{")) return JSON.parse(text);
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  return data.length > 0 ? JSON.parse(data[data.length - 1] as string) : undefined;
}

/**
 * A keep-alive client: the socket stays open after each response until the
 * server closes it — its `keepAliveTimeout`, 5 s by default and often 65 s
 * behind a load balancer. What a fetch-based client does for a few seconds
 * (undici's own idle timeout), and what an unbounded `http.close()` waited
 * for: 4.5 s with a 1.5 s call in flight, measured. Replaced per test.
 */
let agent = new Agent({ keepAlive: true, maxSockets: 1 });

/** One JSON-RPC request over the keep-alive client. */
function rpc(port: number, method: string, params: Record<string, unknown>): Promise<unknown> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        agent,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "user-agent": UA,
          "mcp-protocol-version": PROTOCOL,
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(parseBody(data));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const call = (port: number, name: string, args: Record<string, unknown>) =>
  rpc(port, "tools/call", { name, arguments: args, _meta: { "openai/session": "conv-child" } });

async function drive(port: number): Promise<void> {
  await rpc(port, "initialize", {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: "openai-mcp", version: "1.0.0" },
  });
  await rpc(port, "tools/list", {});
  for (let i = 0; i < 50; i++) {
    const result = (await call(port, "get_price", { sku: `pre-${i}` })) as {
      result?: { isError?: boolean };
    };
    expect(result.result?.isError).toBeFalsy();
  }
}

/**
 * A `slow` call that is in flight when the test sends the signal: resolves
 * once the child reports the tool started, with the call's own promise in
 * `done` — wrapped, since an async function returning a promise would adopt
 * it and only resolve once the call ended, after the signal was meant to go.
 */
async function inFlight(child: Child, ms: number): Promise<{ done: Promise<unknown> }> {
  const done = call(child.port, "slow", { sku: "late", ms }).catch(() => undefined);
  await child.waitForOutput(/started late/);
  return { done };
}

const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b, 0);

describe.each(STACKS)("a stateless host as a child process on MCP SDK %s (#142, #148)", (stack) => {
  let ingest: MockIngest;
  /** Every process spawned by the test, ready or not, so none outlives it. */
  let spawned: ChildProcess[];

  beforeEach(async () => {
    spawned = [];
    ingest = await startMockIngest({ respondAfterMs: 150 });
  });

  afterEach(async () => {
    // A child that is still running — one that hung after the signal the
    // test sent (`proc.killed` is already true then), or one that never
    // became ready — is killed for good.
    for (const proc of spawned) {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }
    agent.destroy();
    agent = new Agent({ keepAlive: true, maxSockets: 1 });
    await ingest.close();
  });

  const start = (mode: Mode, endpoint = ingest.endpoint, env?: Record<string, string>) =>
    startChild(
      {
        stack,
        mode,
        endpoint,
        env,
        counters: () => ({ responded: ingest.responded, batches: ingest.batches.length }),
      },
      (proc) => {
        spawned.push(proc);
      },
    );

  /** The connection event a stateless instance records without ever seeing `initialize`. */
  function expectConnectionFromHeaders() {
    const connections = ingest.ofType("connection");
    expect(connections).toHaveLength(1);
    expect(connections[0]?.client_name).toBe("openai-mcp");
    expect(connections[0]?.client_version).toBe("1.0.0");
    expect(connections[0]?.protocol_version).toBe(PROTOCOL);
    expect(connections[0]?.metadata).toEqual({
      intent_enabled: false,
      client_info_source: "user_agent",
    });
  }

  it(
    "the README recipe with nothing in flight delivers every event and exits 0",
    { timeout: 30_000 },
    async () => {
      const child = await start("readme");
      await drive(child.port);
      // Every call finished; the events sit in the SDK's buffer (or, on a
      // runner slow enough for the 10 s flush timer to have fired, some are
      // already out — the drain below still has to deliver the rest).
      child.kill("SIGTERM");
      const exit = await child.exited;

      expect(exit, child.output()).toMatchObject({ code: 0, signal: null });
      expect(exit.afterSignalMs).toBeLessThan(5_000);
      expect(ingest.ofType("tool_call")).toHaveLength(50);
      expect(
        ingest
          .ofType("tool_discovery")
          .map((e) => e.tool_name)
          .sort(),
      ).toEqual(["get_price", "slow"]);
      // Every batch was answered before the process exited: shutdown() waited.
      expect(exit.atExit.batches).toBeGreaterThan(0);
      expect(exit.atExit.responded).toBe(exit.atExit.batches);
      expect(child.lossLines()).toEqual([]);
      expectConnectionFromHeaders();
    },
  );

  it(
    "the README recipe with a request in flight delivers every event, that request's included, and exits 0",
    { timeout: 30_000 },
    async () => {
      const child = await start("readme");
      await drive(child.port);

      // One request still being served when the signal arrives; the
      // keep-alive socket it answers on is what an unbounded close waited
      // for (4.5–5.5 s measured) and what the bounded close cuts within 100 ms.
      const { done: slow } = await inFlight(child, 400);
      child.kill("SIGTERM");
      const exit = await child.exited;
      await slow;

      expect(exit, child.output()).toMatchObject({ code: 0, signal: null });
      expect(exit.afterSignalMs).toBeLessThan(3_000);
      const calls = ingest.ofType("tool_call");
      expect(calls).toHaveLength(51);
      expect(calls.filter((e) => e.event_name === "slow")).toHaveLength(1);
      expect(
        ingest
          .ofType("tool_discovery")
          .map((e) => e.tool_name)
          .sort(),
      ).toEqual(["get_price", "slow"]);
      // Ordering, not counts: the in-flight call's event was sent after the
      // signal (the close waited for it), and every batch — that one
      // included — was answered before the process exited.
      const slowBatch = ingest.batches.find((b) => b.events.some((e) => e.event_name === "slow"));
      expect(slowBatch?.receivedAt).toBeGreaterThanOrEqual(child.signalAt());
      expect(exit.atExit.responded).toBe(exit.atExit.batches);
      // ... and no batch arrived after the exit: the snapshot saw them all
      // (a late batch read after the exit event would otherwise pass).
      expect(ingest.batches.length).toBe(exit.atExit.batches);
      expect(child.lossLines()).toEqual([]);
      expectConnectionFromHeaders();
    },
  );

  it(
    "ingest hanging, a 1.5 s request in flight, no option set: the README recipe exits 0 within 5 s of SIGTERM, not before the 4 s deadline, every loss counted",
    { timeout: 30_000 },
    async () => {
      ingest.hangEvents = true;
      const child = await start("readme");
      await drive(child.port);
      const { done: slow } = await inFlight(child, 1_500);
      child.kill("SIGTERM");
      const exit = await child.exited;
      await slow;

      // Before #148: the close waited for the keep-alive socket, then the
      // handler's shutdown() waited its own 10 s — 15–18 s in all.
      expect(exit, child.output()).toMatchObject({ code: 0, signal: null });
      expect(exit.afterSignalMs).toBeGreaterThanOrEqual(3_900);
      expect(exit.afterSignalMs).toBeLessThan(5_000);
      // Everything reached ingest, nothing was answered, and every event is
      // accounted for: the cycle's line (the drained transport) plus the exit
      // hook's (the in-flight request's event, sent after the signal).
      expect(ingest.responded).toBe(0);
      expect(ingest.events).toHaveLength(EVENTS_BEFORE_SIGNAL + 1);
      expect(child.lossLines().length).toBeLessThanOrEqual(2);
      expect(sum(child.lossLines())).toBe(EVENTS_BEFORE_SIGNAL + 1);
    },
  );

  it(
    "ingest refusing, a 1.5 s request in flight, no option set: the README recipe exits 0 within 5 s of SIGTERM, every loss counted",
    { timeout: 30_000 },
    async () => {
      const child = await start("readme", await refusedEndpoint());
      await drive(child.port);
      const { done: slow } = await inFlight(child, 1_500);
      child.kill("SIGTERM");
      const exit = await child.exited;
      await slow;

      expect(exit, child.output()).toMatchObject({ code: 0, signal: null });
      expect(exit.afterSignalMs).toBeLessThan(5_000);
      expect(ingest.events).toHaveLength(0);
      // The drained transport's events are the deadline's loss (its third
      // backoff would have ended past the deadline): one YAVIO-1205 line.
      // The in-flight request's event went through the post-signal
      // transport's single attempt and was refused: a delivery failure with
      // its own YAVIO-1201 line, not a deadline loss (#148 review round 2).
      expect(sum(child.lossLines())).toBe(EVENTS_BEFORE_SIGNAL);
      expect(child.output()).toContain("YAVIO-1201");
    },
  );
});

describe("a stateless host as a child process: signals, handlers and budgets (#148)", () => {
  let ingest: MockIngest;
  let spawned: ChildProcess[];

  beforeEach(async () => {
    spawned = [];
    ingest = await startMockIngest({ respondAfterMs: 150 });
  });

  afterEach(async () => {
    for (const proc of spawned) {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }
    agent.destroy();
    agent = new Agent({ keepAlive: true, maxSockets: 1 });
    await ingest.close();
  });

  const start = (mode: Mode, endpoint = ingest.endpoint, env?: Record<string, string>) =>
    startChild(
      {
        stack: "v1",
        mode,
        endpoint,
        env,
        counters: () => ({ responded: ingest.responded, batches: ingest.batches.length }),
      },
      (proc) => {
        spawned.push(proc);
      },
    );

  it(
    "with no handler of its own: the SDK drains, hands the signal back, Node exits by the signal",
    { timeout: 30_000 },
    async () => {
      const child = await start("none");
      await drive(child.port);
      child.kill("SIGTERM");
      const exit = await child.exited;

      expect(exit, child.output()).toMatchObject({ code: null, signal: "SIGTERM" });
      expect(exit.afterSignalMs).toBeLessThan(5_000);
      expect(ingest.ofType("tool_call")).toHaveLength(50);
      expect(ingest.ofType("connection")).toHaveLength(1);
      expect(exit.atExit.batches).toBeGreaterThan(0);
      expect(exit.atExit.responded).toBe(exit.atExit.batches);
      expect(child.lossLines()).toEqual([]);
    },
  );

  it(
    "no handler, ingest hanging, a request in flight: exit by the signal within 5 s, one YAVIO-1205 line with the right count",
    { timeout: 30_000 },
    async () => {
      ingest.hangEvents = true;
      const child = await start("none");
      await drive(child.port);
      const { done: slow } = await inFlight(child, 1_500);
      child.kill("SIGTERM");
      const exit = await child.exited;
      await slow;

      // The re-raise ends the process at the deadline: the in-flight request's
      // event, sent after the signal, is cut with it — and counted. Before
      // #148 the exit came at 10 s and that event's loss was silent.
      expect(exit, child.output()).toMatchObject({ code: null, signal: "SIGTERM" });
      expect(exit.afterSignalMs).toBeGreaterThanOrEqual(3_900);
      expect(exit.afterSignalMs).toBeLessThan(5_000);
      expect(ingest.responded).toBe(0);
      expect(ingest.events).toHaveLength(EVENTS_BEFORE_SIGNAL + 1);
      expect(child.lossLines()).toEqual([EVENTS_BEFORE_SIGNAL + 1]);
      expect(child.output()).toContain("deadline of 4000 ms");
    },
  );

  it(
    "the README recipe on SIGINT (Fly.io's default signal): every event delivered, exit 0",
    { timeout: 30_000 },
    async () => {
      const child = await start("readme");
      await drive(child.port);
      const { done: slow } = await inFlight(child, 400);
      child.kill("SIGINT");
      const exit = await child.exited;
      await slow;

      // Before #148 the README handler listened to SIGTERM only: SIGINT
      // ended the process at once and cut the request in flight.
      expect(exit, child.output()).toMatchObject({ code: 0, signal: null });
      expect(exit.afterSignalMs).toBeLessThan(5_000);
      expect(ingest.ofType("tool_call")).toHaveLength(51);
      expect(exit.atExit.responded).toBe(exit.atExit.batches);
      expect(child.lossLines()).toEqual([]);
    },
  );

  it.each([
    ["refusing", "refuse"],
    ["hanging", "hang"],
  ] as const)(
    "a handler without process.exit(), ingest %s: the process exits on its own within 5 s",
    { timeout: 30_000 },
    async (_label, ingestMode) => {
      let endpoint = ingest.endpoint;
      if (ingestMode === "hang") ingest.hangEvents = true;
      else endpoint = await refusedEndpoint();
      const child = await start("noexit", endpoint);
      await drive(child.port);
      child.kill("SIGTERM");
      const exit = await child.exited;

      // Before #148 the retry loop's timers and the 30 s fetch timeout kept
      // the process alive: 31 s against a refusing ingest, over 40 s against
      // a hanging one. The hanging case is the one that needs the abort.
      expect(exit, child.output()).toMatchObject({ code: 0, signal: null });
      expect(exit.afterSignalMs).toBeLessThan(5_000);
      expect(sum(child.lossLines())).toBe(EVENTS_BEFORE_SIGNAL);
    },
  );

  it(
    "a handler without process.exit(), ingest hanging, a 1.5 s request in flight: its late send keeps nothing alive past the deadline — exit within D + 0.5 s",
    { timeout: 30_000 },
    async () => {
      ingest.hangEvents = true;
      const child = await start("noexit");
      await drive(child.port);
      const { done: slow } = await inFlight(child, 1_500);
      child.kill("SIGTERM");
      const exit = await child.exited;
      await slow;

      // The request finishes at signal + 1.5 s and its event goes out
      // through the post-signal transport, whose fetch runs within what is
      // left of the cycle. Before the fix that transport got a fetch timeout
      // of min(30 s, D) = 4 s from its creation: the socket kept the process
      // alive until signal + 5.5 s, past Fly.io's 5 s.
      expect(exit, child.output()).toMatchObject({ code: 0, signal: null });
      expect(exit.afterSignalMs).toBeGreaterThanOrEqual(3_900);
      expect(exit.afterSignalMs).toBeLessThan(4_500);
      expect(ingest.responded).toBe(0);
      expect(ingest.events).toHaveLength(EVENTS_BEFORE_SIGNAL + 1);
      expect(sum(child.lossLines())).toBe(EVENTS_BEFORE_SIGNAL + 1);
    },
  );

  it(
    "YAVIO_SHUTDOWN_TIMEOUT_MS=8000 with an ingest answering after 6 s: delivered",
    { timeout: 30_000 },
    async () => {
      ingest.respondAfterMs = 6_000;
      const child = await start("readme", ingest.endpoint, { YAVIO_SHUTDOWN_TIMEOUT_MS: "8000" });
      await drive(child.port);
      child.kill("SIGTERM");
      const exit = await child.exited;

      expect(exit, child.output()).toMatchObject({ code: 0, signal: null });
      expect(exit.afterSignalMs).toBeGreaterThanOrEqual(5_900);
      expect(exit.afterSignalMs).toBeLessThan(9_000);
      expect(ingest.ofType("tool_call")).toHaveLength(50);
      expect(exit.atExit.responded).toBe(exit.atExit.batches);
      expect(child.lossLines()).toEqual([]);
    },
  );
});

describe("the README's shutdown recipe (#148)", () => {
  it("is the fixture's code: the fenced block after the marker equals the text between the fixture's markers", () => {
    const readme = readFileSync(join(SDK_DIR, "README.md"), "utf8");
    const marker = readme.indexOf("<!-- shutdown-recipe -->");
    expect(marker).toBeGreaterThan(0);
    const fence = /```typescript\n([\s\S]*?)```/.exec(readme.slice(marker));
    expect(fence).not.toBeNull();

    const fixture = readFileSync(FIXTURE, "utf8");
    const from = fixture.indexOf("// shutdown-recipe:start\n");
    const to = fixture.indexOf("// shutdown-recipe:end");
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const block = fixture.slice(from + "// shutdown-recipe:start\n".length, to);

    expect(block.trim()).toBe((fence as RegExpExecArray)[1]?.trim());
  });
});
