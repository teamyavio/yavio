/**
 * The README's graceful-shutdown pattern in a real process (#142): a
 * stateless host as a child, 50 calls from one conversation, then SIGTERM
 * — once with nothing in flight, once with one request still being served.
 * Before 0.5.2 the app's `await shutdown()` resolved in 3 ms with the drain
 * still running and `process.exit(0)` lost every event (0 of 53 with
 * nothing in flight); with no handler of its own the SDK drained and handed
 * the signal back, so that case delivered. All three are asserted here
 * against a mock ingest that answers 150 ms late, like a remote one.
 *
 * The child runs the SDK's source through tsx (`node --import tsx`), on
 * whichever MCP SDK v1 the lockfile or the compat matrix installed.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MockIngest, startMockIngest } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "stateless-host.ts");
/** packages/sdk — `--import tsx` resolves from the working directory. */
const SDK_DIR = join(here, "..", "..", "..");
const UA = "openai-mcp/1.0.0";
const PROTOCOL = "2025-06-18";

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The ingest's counters the moment the child exited: what it waited for before it went. */
  atExit: { responded: number; batches: number };
}

interface Child {
  proc: ChildProcess;
  port: number;
  output: () => string;
  exited: Promise<Exit>;
  /** Resolve once the child's output matches, or reject when it exits first. */
  waitForOutput: (pattern: RegExp, timeoutMs?: number) => Promise<void>;
}

async function startChild(
  mode: "readme" | "none",
  ingest: MockIngest,
  onSpawn: (proc: ChildProcess) => void,
): Promise<Child> {
  const proc = spawn(process.execPath, ["--import", "tsx", FIXTURE], {
    cwd: SDK_DIR,
    env: {
      ...process.env,
      ENDPOINT: ingest.endpoint,
      MODE: mode,
      YAVIO_API_KEY: "",
      YAVIO_ENDPOINT: "",
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
  const exited = new Promise<Exit>((resolve) =>
    proc.on("exit", (code, signal) =>
      resolve({
        code,
        signal,
        atExit: { responded: ingest.responded, batches: ingest.batches.length },
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
  return { proc, port, output: () => out, exited, waitForOutput };
}

let rpcId = 0;
/** One JSON-RPC request, no keep-alive: `http.close()`'s callback then waits for in-flight requests only. */
function rpc(port: number, method: string, params: Record<string, unknown>): Promise<unknown> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        agent: false,
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
            resolve(JSON.parse(data));
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

describe("a stateless host as a child process, SIGTERM (#142)", () => {
  let ingest: MockIngest;
  /** Every process spawned by the test, ready or not, so none outlives it. */
  let spawned: ChildProcess[];

  beforeEach(async () => {
    spawned = [];
    ingest = await startMockIngest({ respondAfterMs: 150 });
  });

  afterEach(async () => {
    // A child that is still running — one that hung after the SIGTERM the
    // test sent (`proc.killed` is already true then), or one that never
    // became ready — is killed for good.
    for (const proc of spawned) {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }
    await ingest.close();
  });

  const start = (mode: "readme" | "none") =>
    startChild(mode, ingest, (proc) => {
      spawned.push(proc);
    });

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
    "the README handler with nothing in flight delivers every event and exits 0",
    { timeout: 30_000 },
    async () => {
      const child = await start("readme");
      await drive(child.port);
      // Every call finished; the events sit in the SDK's buffer (or, on a
      // runner slow enough for the 10 s flush timer to have fired, some are
      // already out — the drain below still has to deliver the rest).
      child.proc.kill("SIGTERM");
      const exit = await child.exited;

      expect(exit, child.output()).toMatchObject({ code: 0, signal: null });
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
      expectConnectionFromHeaders();
    },
  );

  it(
    "the README handler with a request in flight delivers every event, that request's included, and exits 0",
    { timeout: 30_000 },
    async () => {
      const child = await start("readme");
      await drive(child.port);

      // One request still being served when the signal arrives.
      const slow = call(child.port, "slow", { sku: "late", ms: 400 }).catch(() => undefined);
      await child.waitForOutput(/started late/);
      const signalAt = Date.now();
      child.proc.kill("SIGTERM");
      const exit = await child.exited;
      await slow;

      expect(exit, child.output()).toMatchObject({ code: 0, signal: null });
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
      // signal (http.close waited for it), and every batch — that one
      // included — was answered before the process exited.
      const slowBatch = ingest.batches.find((b) => b.events.some((e) => e.event_name === "slow"));
      expect(slowBatch?.receivedAt).toBeGreaterThanOrEqual(signalAt);
      expect(exit.atExit.responded).toBe(exit.atExit.batches);
      // ... and no batch arrived after the exit: the snapshot saw them all
      // (a late batch read after the exit event would otherwise pass).
      expect(ingest.batches.length).toBe(exit.atExit.batches);
      expectConnectionFromHeaders();
    },
  );

  it(
    "with no handler of its own: the SDK drains, hands the signal back, Node exits by the signal",
    { timeout: 30_000 },
    async () => {
      const child = await start("none");
      await drive(child.port);
      child.proc.kill("SIGTERM");
      const exit = await child.exited;

      expect(exit, child.output()).toMatchObject({ code: null, signal: "SIGTERM" });
      expect(ingest.ofType("tool_call")).toHaveLength(50);
      expect(ingest.ofType("connection")).toHaveLength(1);
      expect(exit.atExit.batches).toBeGreaterThan(0);
      expect(exit.atExit.responded).toBe(exit.atExit.batches);
    },
  );
});
