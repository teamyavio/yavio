/**
 * A host that the platform freezes once the response is out (#171): AWS
 * Lambda between invocations, Vercel Functions, Cloud Run with request-based
 * billing. The child (`fixtures/freeze-host.ts`) serves one MCP tool call
 * per invocation; after each response — and after what the platform's
 * `waitUntil` was handed has settled — the test stops it with `SIGSTOP`, so
 * no timer of the SDK's runs, counts the tool calls at the mock ingest, and
 * resumes it with `SIGCONT` for the next invocation. In the end the frozen
 * instance is killed with `SIGKILL`, without a signal it could act on, as a
 * platform recycles it. Before #171 the 10 s flush interval held every
 * event until then: none reached ingest. Run on MCP SDK v1 and v2.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MockIngest, startMockIngest } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "freeze-host.ts");
/** packages/sdk — `--import tsx` resolves from the working directory. */
const SDK_DIR = join(here, "..", "..", "..");
const INVOCATIONS = 3;
const FREEZE_MS = 300;
const TIMEOUT_MS = 30_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Mode = "none" | "await" | "sent" | "early";

interface Run {
  /** Tool calls at ingest at each freeze, in order. */
  atFreeze: number[];
  /** Tool calls at ingest when the frozen instance was killed. */
  atKill: number;
  output: string;
}

describe.each(["v1", "v2"] as const)(
  "an instance frozen after every response, MCP SDK %s (#171)",
  (stack) => {
    let ingest: MockIngest;
    let spawned: ChildProcess[];
    const calls = () => ingest.ofType("tool_call").length;

    beforeEach(async () => {
      spawned = [];
      ingest = await startMockIngest();
    });

    afterEach(async () => {
      for (const proc of spawned) {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill("SIGCONT");
          proc.kill("SIGKILL");
        }
      }
      await ingest.close();
    });

    async function start(
      mode: Mode,
      toolMs: number,
    ): Promise<{ port: number; proc: ChildProcess; output: () => string }> {
      const proc = spawn(process.execPath, ["--import", "tsx", FIXTURE], {
        cwd: SDK_DIR,
        env: {
          ...process.env,
          ENDPOINT: ingest.endpoint,
          STACK: stack,
          MODE: mode,
          TOOL_MS: String(toolMs),
          YAVIO_API_KEY: "",
          YAVIO_ENDPOINT: "",
          YAVIO_SHUTDOWN_TIMEOUT_MS: "",
          YAVIO_FLUSH_TIMEOUT_MS: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      spawned.push(proc);
      let out = "";
      proc.stdout?.on("data", (chunk) => {
        out += chunk;
      });
      proc.stderr?.on("data", (chunk) => {
        out += chunk;
      });
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`the child never became ready:\n${out}`)),
          20_000,
        );
        const poll = setInterval(() => {
          const ready = out.match(/ready (\d+)/);
          if (!ready) return;
          clearInterval(poll);
          clearTimeout(timer);
          resolve(Number(ready[1]));
        }, 20);
        proc.on("exit", () => {
          clearInterval(poll);
          clearTimeout(timer);
          reject(new Error(`the child exited:\n${out}`));
        });
      });
      return { port, proc, output: () => out };
    }

    async function run(mode: Mode, toolMs = 0): Promise<Run> {
      const child = await start(mode, toolMs);
      const atFreeze: number[] = [];
      for (let i = 1; i <= INVOCATIONS; i++) {
        const response = await fetch(`http://127.0.0.1:${child.port}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-06-18",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: i,
            method: "tools/call",
            params: {
              name: "echo",
              arguments: { q: `r${i}` },
              _meta: { "openai/session": "conv-f" },
            },
          }),
          signal: AbortSignal.timeout(10_000),
        });
        expect(await response.text(), child.output()).toContain(`r${i}`);
        // The platform freezes once what its waitUntil holds has settled.
        await (await fetch(`http://127.0.0.1:${child.port}/__quiet`)).text();
        child.proc.kill("SIGSTOP");
        await sleep(50); // what the instance sent before the freeze finishes arriving
        atFreeze.push(calls());
        await sleep(FREEZE_MS);
        if (i < INVOCATIONS) child.proc.kill("SIGCONT");
      }
      const atKill = calls();
      child.proc.kill("SIGKILL"); // recycled while frozen: no signal it could act on
      return { atFreeze, atKill, output: child.output() };
    }

    it(
      "nothing after the response (the README before #171): no tool call at ingest at any freeze, none when the instance is recycled",
      async () => {
        const { atFreeze, atKill } = await run("none");
        expect(atFreeze).toEqual([0, 0, 0]);
        expect(atKill).toBe(0);
      },
      TIMEOUT_MS,
    );

    it(
      "await analytics.flush() once the body is complete: every invocation's tool call at ingest at every freeze, no line",
      async () => {
        const { atFreeze, atKill, output } = await run("await");
        expect(atFreeze, output).toEqual([1, 2, 3]);
        expect(atKill).toBe(3);
        expect(output).not.toMatch(/YAVIO-12\d\d/);
      },
      TIMEOUT_MS,
    );

    it(
      "flushWhenSent(response, waitUntil): every invocation's tool call at ingest at every freeze",
      async () => {
        const { atFreeze, atKill, output } = await run("sent");
        expect(atFreeze, output).toEqual([1, 2, 3]);
        expect(atKill).toBe(3);
        expect(output).not.toMatch(/YAVIO-12\d\d/);
      },
      TIMEOUT_MS,
    );

    if (stack === "v2") {
      it(
        "a streamed response and a 200 ms tool: flushWhenSent has every call at ingest at every freeze, where waitUntil(flush()) right after fetch() leaves each call for the next invocation",
        async () => {
          const naive = await run("early", 200);
          expect(naive.atFreeze, naive.output).toEqual([0, 1, 2]);
          const sent = await run("sent", 200);
          expect(
            sent.atFreeze.map((n) => n - naive.atKill),
            sent.output,
          ).toEqual([1, 2, 3]);
        },
        TIMEOUT_MS,
      );
    }
  },
);
