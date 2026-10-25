/**
 * AWS Lambda's freeze between invocations (#171), with a reduction of the
 * Node 20/22 runtime interface client as the child
 * (`fixtures/lambda-runtime.ts`). The test serves the Runtime API: it hands
 * out one event per invocation and, when the child asks for the next one,
 * freezes it with `SIGSTOP` — Lambda freezes the execution environment once
 * the invocation is complete — counts the tool calls at the mock ingest, and
 * resumes it for the next event. In the end the frozen child is killed:
 * Lambda recycles environments without a signal unless an extension is
 * registered. A promise handler (the only style on Node 24) never empties
 * the loop, so neither the signal path (#148) nor #178's `beforeExit` drain
 * runs, and before #171 every event stayed in the buffer.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MockIngest, startMockIngest } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "lambda-runtime.ts");
const SDK_DIR = join(here, "..", "..", "..");
const INVOCATIONS = 3;
const FREEZE_MS = 300;
const TIMEOUT_MS = 30_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Invocation {
  /** Tool calls at ingest when the environment was frozen after it. */
  atFreeze: number;
  /** `beforeExit` emits so far in the child. */
  beforeExitEmits: number;
  /** Live shared states when the invocation began. */
  registry: number;
  result: unknown;
}

describe("AWS Lambda: the runtime client freezes the environment after every invocation (#171)", () => {
  let ingest: MockIngest;
  let api: Server | undefined;
  let child: ChildProcess | undefined;
  const calls = () => ingest.ofType("tool_call").length;

  beforeEach(async () => {
    ingest = await startMockIngest();
  });

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGCONT");
      child.kill("SIGKILL");
    }
    child = undefined;
    api?.closeAllConnections();
    await new Promise<void>((resolve) => (api ? api.close(() => resolve()) : resolve()));
    api = undefined;
    await ingest.close();
  });

  async function run(
    style: "async" | "callback",
    flush: boolean,
  ): Promise<{ rows: Invocation[]; atKill: number; output: string }> {
    let nextWaiter: ((res: ServerResponse) => void) | undefined;
    let pendingNext: ServerResponse | undefined;
    let responseWaiter: ((body: { result: unknown; beforeExitEmits: number }) => void) | undefined;
    api = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        if (req.url === "/next") {
          if (nextWaiter) {
            const waiter = nextWaiter;
            nextWaiter = undefined;
            waiter(res);
          } else pendingNext = res;
          return;
        }
        res.writeHead(202);
        res.end();
        responseWaiter?.(JSON.parse(body));
        responseWaiter = undefined;
      });
    });
    await new Promise<void>((resolve) => api?.listen(0, "127.0.0.1", resolve));
    const runtime = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    const nextRequest = () =>
      new Promise<ServerResponse>((resolve) => {
        if (pendingNext) {
          const res = pendingNext;
          pendingNext = undefined;
          resolve(res);
        } else nextWaiter = resolve;
      });

    const proc = spawn(process.execPath, ["--import", "tsx", FIXTURE], {
      cwd: SDK_DIR,
      env: {
        ...process.env,
        RUNTIME_API: runtime,
        ENDPOINT: ingest.endpoint,
        STYLE: style,
        FLUSH: flush ? "1" : "0",
        YAVIO_API_KEY: "",
        YAVIO_ENDPOINT: "",
        YAVIO_SHUTDOWN_TIMEOUT_MS: "",
        YAVIO_FLUSH_TIMEOUT_MS: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    let out = "";
    proc.stdout?.on("data", (chunk) => {
      out += chunk;
    });
    proc.stderr?.on("data", (chunk) => {
      out += chunk;
    });

    const rows: Invocation[] = [];
    let next = await nextRequest(); // init done: the first /next
    for (let i = 0; i < INVOCATIONS; i++) {
      const answered = new Promise<{ result: unknown; beforeExitEmits: number }>((resolve) => {
        responseWaiter = resolve;
      });
      next.writeHead(200, { "content-type": "application/json" });
      next.end(JSON.stringify({ id: `inv${i}`, event: { q: `r${i}` } }));
      const body = await answered;
      next = await nextRequest(); // the runtime asks for the next event: Lambda freezes now
      proc.kill("SIGSTOP");
      await sleep(50);
      const result = body.result as { registry?: number } | null;
      rows.push({
        atFreeze: calls(),
        beforeExitEmits: body.beforeExitEmits,
        registry: result?.registry ?? -1,
        result: body.result,
      });
      await sleep(FREEZE_MS);
      if (i < INVOCATIONS - 1) proc.kill("SIGCONT");
    }
    const atKill = calls();
    proc.kill("SIGKILL");
    return { rows, atKill, output: out };
  }

  it(
    "an async handler with await analytics.flush() before it returns: every invocation's tool call at ingest at every freeze",
    async () => {
      const { rows, atKill, output } = await run("async", true);
      expect(
        rows.map((r) => r.result),
        output,
      ).toEqual([
        { text: "r0", registry: 1 },
        { text: "r1", registry: 1 },
        { text: "r2", registry: 1 },
      ]);
      expect(rows.map((r) => r.atFreeze)).toEqual([1, 2, 3]);
      expect(rows.map((r) => r.beforeExitEmits)).toEqual([0, 0, 0]); // the loop never empties
      expect(atKill).toBe(3);
    },
    TIMEOUT_MS,
  );

  it(
    "a callback handler with await analytics.flush() before the callback: delivered at every freeze, and #178's beforeExit drain finds nothing to stop — the key's entry stays in the registry",
    async () => {
      const { rows, output } = await run("callback", true);
      expect(
        rows.map((r) => r.atFreeze),
        output,
      ).toEqual([1, 2, 3]);
      expect(rows.map((r) => r.beforeExitEmits)).toEqual([1, 2, 3]); // the drain ran after each
      expect(rows.map((r) => r.registry)).toEqual([1, 1, 1]);
    },
    TIMEOUT_MS,
  );

  it(
    "controls: an async handler without a flush delivers nothing at any freeze; a callback handler without one is drained by #178 after every invocation, which takes the entry out each time",
    async () => {
      const plain = await run("async", false);
      expect(
        plain.rows.map((r) => r.atFreeze),
        plain.output,
      ).toEqual([0, 0, 0]);
      expect(plain.atKill).toBe(0);
      api?.closeAllConnections();
      await new Promise<void>((resolve) => api?.close(() => resolve()));
      api = undefined;
      const drained = await run("callback", false);
      expect(
        drained.rows.map((r) => r.atFreeze),
        drained.output,
      ).toEqual([1, 2, 3]);
      expect(drained.rows.map((r) => r.registry)).toEqual([1, 0, 0]);
    },
    TIMEOUT_MS,
  );
});
