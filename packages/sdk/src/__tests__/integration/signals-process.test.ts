/**
 * The README's graceful-shutdown pattern in a real process (#142): a
 * stateless host as a child, 50 calls from one conversation plus one still
 * in flight, then SIGTERM. Before 0.5.2 the app's `await shutdown()`
 * resolved in 3 ms with the drain still running and `process.exit(0)` lost
 * every event (0/53); with no handler of its own the SDK drained and handed
 * the signal back, so that case delivered. Both are asserted here against a
 * mock ingest that answers 150 ms late, like a remote one.
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

interface Child {
  proc: ChildProcess;
  port: number;
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

async function startChild(mode: "readme" | "none", endpoint: string): Promise<Child> {
  const proc = spawn(process.execPath, ["--import", "tsx", FIXTURE], {
    cwd: SDK_DIR,
    env: { ...process.env, ENDPOINT: endpoint, MODE: mode, YAVIO_API_KEY: "", YAVIO_ENDPOINT: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout?.on("data", (chunk) => {
    out += chunk;
  });
  proc.stderr?.on("data", (chunk) => {
    out += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    proc.on("exit", (code, signal) => resolve({ code, signal })),
  );
  const port = await new Promise<number>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`child did not start:\n${out}`)), 30_000);
    const poll = setInterval(() => {
      const m = out.match(/ready (\d+)/);
      if (m) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve(Number(m[1]));
      }
    }, 20);
    void exited.then(() => {
      clearInterval(poll);
      clearTimeout(deadline);
      reject(new Error(`child exited before it was ready:\n${out}`));
    });
  });
  return { proc, port, output: () => out, exited };
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
  let child: Child | undefined;

  beforeEach(async () => {
    ingest = await startMockIngest({ respondAfterMs: 150 });
  });

  afterEach(async () => {
    if (child?.proc.exitCode === null && !child.proc.killed) child.proc.kill("SIGKILL");
    child = undefined;
    await ingest.close();
  });

  it(
    "the README handler delivers every event, the in-flight request's included, and exits 0",
    { timeout: 30_000 },
    async () => {
      child = await startChild("readme", ingest.endpoint);
      await drive(child.port);
      expect(ingest.events).toHaveLength(0); // batched, nothing flushed yet

      // One request still being served when the signal arrives.
      const slow = call(child.port, "slow", { sku: "late", ms: 400 }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      child.proc.kill("SIGTERM");
      const exit = await child.exited;
      await slow;

      expect(exit, child.output()).toEqual({ code: 0, signal: null });
      const calls = ingest.ofType("tool_call");
      expect(calls).toHaveLength(51);
      expect(calls.filter((e) => e.event_name === "slow")).toHaveLength(1);
      expect(
        ingest
          .ofType("tool_discovery")
          .map((e) => e.tool_name)
          .sort(),
      ).toEqual(["get_price", "slow"]);
      // Every batch was answered before the process exited: shutdown() waited.
      expect(ingest.responded).toBe(ingest.batches.length);
      // The instance serving tools/call never saw initialize: the client
      // comes from the User-Agent, the protocol version from its header.
      const connections = ingest.ofType("connection");
      expect(connections).toHaveLength(1);
      expect(connections[0]?.client_name).toBe("openai-mcp");
      expect(connections[0]?.client_version).toBe("1.0.0");
      expect(connections[0]?.protocol_version).toBe(PROTOCOL);
      expect(connections[0]?.metadata).toEqual({
        intent_enabled: false,
        client_info_source: "user_agent",
      });
    },
  );

  it(
    "with no handler of its own: the SDK drains, hands the signal back, Node exits by the signal",
    { timeout: 30_000 },
    async () => {
      child = await startChild("none", ingest.endpoint);
      await drive(child.port);
      child.proc.kill("SIGTERM");
      const exit = await child.exited;

      expect(exit, child.output()).toEqual({ code: null, signal: "SIGTERM" });
      expect(ingest.ofType("tool_call")).toHaveLength(50);
      expect(ingest.ofType("connection")).toHaveLength(1);
      expect(ingest.responded).toBe(ingest.batches.length);
    },
  );
});
