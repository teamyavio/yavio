/**
 * Stop sequences against a stdio server in a real process (`stdio-host.ts`),
 * on MCP SDK v1 and v2, driven by each stack's real `StdioClientTransport`.
 *
 * #175: Claude Code (2.1.310, macOS and Linux) stops a stdio server with
 * `SIGINT`, a `SIGTERM` 100 ms later if the process is still alive, and a
 * `SIGKILL` 400 ms after that — without closing stdin. Before #175 the
 * `SIGTERM` handed the SDK's drain back at once, about 100 ms in, with the
 * batch still in flight. The tests send that sequence, with the `SIGKILL`
 * moved to a backstop (`BACKSTOP_MS`): on a loaded runner the child handles a
 * signal late, and a test racing the real 400 ms would be flaky. Nothing
 * here depends on beating a timer by milliseconds. The delivery case holds
 * ingest's answer until the child has dispatched the `SIGTERM` (the
 * fixture's `SIGNAL_PROBE`) and then answers at once, so before #175 the
 * batch is in flight at the hand-back every time. The hanging case reads the
 * hand-back time against the child's own `SIGINT` dispatch: the earliest it
 * may come is that + 400 ms, and the latest is a generous tolerance. The
 * margin to the real `SIGKILL` is measured in the issue and the PR, not
 * pinned here; the bound itself is pinned in process (`signals.test.ts`).
 *
 * #179: the README's stdio recipe next to `withYavio()`: a shutdown-only
 * `createYavio()` client on the pinned key, `await analytics.shutdown()` on
 * stdin's end, then `process.exit(0)` — or no exit at all — against a
 * hanging ingest. Before #179 that shutdown() only drained the pinned
 * transport: the exit hook's `Process exit … await analytics.shutdown()`
 * line for an app that did await, and without `process.exit()` the hanging
 * fetch held the process for the 30 s fetch timeout and its retry (31.6 s).
 */
import type { ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client as ClientV2 } from "@modelcontextprotocol/client";
import { StdioClientTransport as StdioClientV2 } from "@modelcontextprotocol/client/stdio";
import { Client as ClientV1 } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as StdioClientV1 } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MockIngest, startMockIngest } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "stdio-host.ts");
const SDK_DIR = join(here, "..", "..", "..");
const STACKS = ["v1", "v2"] as const;
type Stack = (typeof STACKS)[number];
/** Claude Code's gap between its SIGINT and its SIGTERM. */
const SIGTERM_AFTER_MS = 100;
/** The SIGKILL, long after Claude Code's 400 ms: a backstop, so a child that hangs fails the test instead of the run. */
const BACKSTOP_MS = 3_000;
const CLIENT_HINT =
  "The client stops the server with SIGINT, SIGTERM and SIGKILL (Claude Code: 100 ms, then 400 ms); a higher shutdownTimeoutMs does not extend that.";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The `YAVIO-1205` lines of an output. */
const lossLines = (output: string): string[] =>
  [...output.matchAll(/\[YAVIO-1205\][^\n]*/g)].map((m) => m[0]);

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** `Date.now()` at the child's exit event. */
  at: number;
}

/** A connected client and its server process. */
interface Wire {
  client: ClientV1 | ClientV2;
  proc: ChildProcess;
  stderr: () => string;
  exited: Promise<Exit>;
  /** Resolves once the child's stderr matches, or once it exited. */
  stderrMatches: (pattern: RegExp) => Promise<void>;
  /** The time the child dispatched a signal (SIGNAL_PROBE), from its own clock. */
  dispatchedAt: (signal: "SIGINT" | "SIGTERM") => number | undefined;
}

describe.each(STACKS)("stop sequences against a stdio server on MCP SDK %s", (stack: Stack) => {
  let ingest: MockIngest;
  let spawned: ChildProcess[];
  let clients: Array<ClientV1 | ClientV2>;

  beforeEach(async () => {
    spawned = [];
    clients = [];
    ingest = await startMockIngest();
  });

  afterEach(async () => {
    for (const proc of spawned) {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }
    for (const client of clients) await client.close().catch(() => {});
    await ingest.answerHung();
    await ingest.close();
  });

  async function open(env: Record<string, string>): Promise<Wire> {
    const params = {
      command: process.execPath,
      args: ["--import", "tsx", FIXTURE],
      cwd: SDK_DIR,
      stderr: "pipe" as const,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        ENDPOINT: ingest.endpoint,
        STACK: stack,
        YAVIO_API_KEY: "",
        YAVIO_ENDPOINT: "",
        YAVIO_SHUTDOWN_TIMEOUT_MS: "",
        ...env,
      },
    };
    const transport = stack === "v2" ? new StdioClientV2(params) : new StdioClientV1(params);
    let stderr = "";
    const watchers: Array<() => void> = [];
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk;
      for (const watch of [...watchers]) watch();
    });
    const client =
      stack === "v2"
        ? new ClientV2({ name: "stop-sequence-test", version: "1.0.0" })
        : new ClientV1({ name: "stop-sequence-test", version: "1.0.0" });
    await client.connect(transport as never);
    clients.push(client);
    // The client's own child: close() drops its reference.
    const proc = (transport as unknown as { _process: ChildProcess })._process;
    spawned.push(proc);
    const exited = new Promise<Exit>((resolve) =>
      proc.once("exit", (code, signal) => resolve({ code, signal, at: Date.now() })),
    );
    const stderrMatches = (pattern: RegExp) =>
      new Promise<void>((resolve) => {
        const watch = () => {
          if (!pattern.test(stderr)) return;
          watchers.splice(watchers.indexOf(watch), 1);
          resolve();
        };
        watchers.push(watch);
        watch();
        void exited.then(() => resolve());
      });
    const dispatchedAt = (signal: "SIGINT" | "SIGTERM") => {
      const match = new RegExp(`\\[fixture\\] ${signal} (\\d+)`).exec(stderr);
      return match ? Number(match[1]) : undefined;
    };
    return { client, proc, stderr: () => stderr, exited, stderrMatches, dispatchedAt };
  }

  /** Five calls through the server: six events queued (connection, five tool_calls). */
  async function fiveCalls(wire: Wire): Promise<void> {
    for (let i = 0; i < 5; i++) {
      const result = (await wire.client.callTool({ name: "echo", arguments: { q: `q${i}` } })) as {
        isError?: boolean;
      };
      expect(result.isError).toBeFalsy();
    }
  }

  /**
   * Claude Code's sequence: SIGINT; after 100 ms a SIGTERM if the process
   * is still alive; the SIGKILL only as a backstop, long after its 400 ms.
   */
  async function claudeCodeStop(proc: ChildProcess): Promise<{ t0: number; killed: boolean }> {
    const alive = () => proc.exitCode === null && proc.signalCode === null;
    const exited = new Promise((resolve) => proc.once("exit", resolve));
    const t0 = Date.now();
    proc.kill("SIGINT");
    await Promise.race([sleep(SIGTERM_AFTER_MS), exited]);
    if (alive()) proc.kill("SIGTERM");
    await Promise.race([sleep(BACKSTOP_MS), exited]);
    const killed = alive();
    if (killed) proc.kill("SIGKILL");
    return { t0, killed };
  }

  describe("Claude Code's stop sequence (#175)", () => {
    it(
      "ingest answering once the child has dispatched the SIGTERM: the batch is answered, not cut, then exit by SIGTERM with no line",
      { timeout: 30_000 },
      async () => {
        ingest.hangEvents = true; // held until the child is past its SIGTERM
        const wire = await open({ MODE: "plain", SIGNAL_PROBE: "1" });
        await fiveCalls(wire);
        const stopping = claudeCodeStop(wire.proc);
        await wire.stderrMatches(/\[fixture\] SIGTERM \d+/);
        ingest.hangEvents = false;
        await ingest.answerHung(); // and every later batch at once
        const { killed } = await stopping;
        const exit = await wire.exited;

        expect(killed, wire.stderr()).toBe(false);
        // Before #175 the child handed back at the SIGTERM with the batch in
        // flight, and its line counted the 6 events: "Shutdown deadline of
        // 4000 ms reached — 6 events not delivered …" (the mock's 200 may
        // still reach the dying socket, so the line is what tells).
        expect(lossLines(wire.stderr())).toEqual([]);
        expect(ingest.batches.map((b) => b.abortedAt)).toEqual([undefined]);
        expect(ingest.ofType("tool_call")).toHaveLength(5);
        // The cycle handed the SIGTERM back at the drain's end, re-raised.
        expect(exit, wire.stderr()).toMatchObject({ code: null, signal: "SIGTERM" });
      },
    );

    it(
      "ingest hanging: exit by SIGTERM at the child's SIGINT + 400 ms, with one line that names that bound and not the hint to raise shutdownTimeoutMs",
      { timeout: 30_000 },
      async () => {
        ingest.hangEvents = true;
        const wire = await open({ MODE: "plain", SIGNAL_PROBE: "1" });
        await fiveCalls(wire);
        const { t0, killed } = await claudeCodeStop(wire.proc);
        const exit = await wire.exited;

        expect(killed, wire.stderr()).toBe(false);
        expect(exit, wire.stderr()).toMatchObject({ code: null, signal: "SIGTERM" });
        const sigintAt = wire.dispatchedAt("SIGINT") as number;
        expect(sigintAt, wire.stderr()).toBeGreaterThanOrEqual(t0);
        // Not before the bound — before #175 the exit came at the SIGTERM,
        // about 100 ms in — and with a tolerance for a loaded host after it.
        expect(exit.at - sigintAt).toBeGreaterThanOrEqual(395);
        expect(exit.at - sigintAt).toBeLessThan(1_500);
        const lines = lossLines(wire.stderr());
        expect(lines, wire.stderr()).toHaveLength(1);
        expect(lines[0]).toMatch(
          /^\[YAVIO-1205\] Shutdown deadline of 400 ms \(SIGTERM \d+ ms after SIGINT\) reached — 6 events not delivered \(queued, in flight or refused after the deadline\)\. /,
        );
        expect(lines[0]?.endsWith(CLIENT_HINT)).toBe(true);
        expect(lines[0]).not.toContain("Raise shutdownTimeoutMs");
        expect(ingest.batches).toHaveLength(1);
        expect(ingest.batches[0]?.abortedAt).toBeDefined();
      },
    );

    it(
      "guard: ingest answering at once: every event arrives and the process exits — by SIGINT when the drain beat the SIGTERM, by SIGTERM otherwise — with no line",
      { timeout: 30_000 },
      async () => {
        const wire = await open({ MODE: "plain" });
        await fiveCalls(wire);
        const { killed } = await claudeCodeStop(wire.proc);
        const exit = await wire.exited;

        expect(killed, wire.stderr()).toBe(false);
        expect(exit.code, wire.stderr()).toBeNull();
        expect(["SIGINT", "SIGTERM"]).toContain(exit.signal);
        expect(ingest.ofType("tool_call")).toHaveLength(5);
        expect(ingest.batches.map((b) => b.abortedAt)).toEqual([undefined]);
        expect(lossLines(wire.stderr())).toEqual([]);
      },
    );
  });

  describe("the README's stdio recipe next to withYavio() (#179)", () => {
    it(
      "ingest hanging, its shutdownTimeoutMs at 1 000: its shutdown() stops the pinned transport at that deadline — one shutdown() line, no hint to await shutdown() — then exit 0 before the client's SIGTERM",
      { timeout: 30_000 },
      async () => {
        ingest.hangEvents = true;
        const wire = await open({ MODE: "stdin-end-with", RECIPE_SHUTDOWN_TIMEOUT_MS: "1000" });
        await fiveCalls(wire);
        const t0 = Date.now();
        await wire.client.close(); // stdin's end; SIGTERM 2 s later
        const exit = await wire.exited;

        expect(exit, wire.stderr()).toMatchObject({ code: 0, signal: null });
        expect(exit.at - t0).toBeGreaterThanOrEqual(950);
        expect(exit.at - t0).toBeLessThan(2_000);
        // Before #179: "Process exit with 6 events not delivered — await
        // analytics.shutdown() before exiting, or raise shutdownTimeoutMs."
        expect(lossLines(wire.stderr())).toEqual([
          "[YAVIO-1205] shutdown() deadline of 1000 ms reached — 6 events not delivered. Raise shutdownTimeoutMs (or YAVIO_SHUTDOWN_TIMEOUT_MS) if the platform's grace period allows.",
        ]);
        expect(ingest.batches).toHaveLength(1);
        expect(ingest.batches[0]?.abortedAt).toBeDefined();
      },
    );

    it(
      "the same without process.exit(), stdin's end only (a client with a long grace): the stop aborts the fetch at 1 000 ms and the process exits on its own within D + 1 s, not after the 30 s fetch timeout",
      { timeout: 45_000 },
      async () => {
        ingest.hangEvents = true;
        const wire = await open({
          MODE: "stdin-end-with-noexit",
          RECIPE_SHUTDOWN_TIMEOUT_MS: "1000",
        });
        await fiveCalls(wire);
        const t0 = Date.now();
        wire.proc.stdin?.end(); // no signal follows: VS Code waits 10 s
        const exit = await wire.exited;

        expect(exit, wire.stderr()).toMatchObject({ code: 0, signal: null });
        // Before #179: 31.6 s — the drain stopped waiting at 1 s, the fetch
        // ran to its 30 s timeout and a retry went out.
        expect(exit.at - t0).toBeGreaterThanOrEqual(950);
        expect(exit.at - t0).toBeLessThan(2_000);
        expect(wire.stderr()).toContain("[fixture] shutdown resolved");
        expect(lossLines(wire.stderr())).toEqual([
          "[YAVIO-1205] shutdown() deadline of 1000 ms reached — 6 events not delivered. Raise shutdownTimeoutMs (or YAVIO_SHUTDOWN_TIMEOUT_MS) if the platform's grace period allows.",
        ]);
        expect(ingest.batches).toHaveLength(1); // no retry went out
      },
    );
  });
});
