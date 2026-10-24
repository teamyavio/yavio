/**
 * A stdio server in a real process, driven by the real `StdioClientTransport`
 * of the stack under test, whose `close()` ends stdin, waits 2 s, sends
 * `SIGTERM`, waits 2 s, sends `SIGKILL` (v1 1.24–1.32, v2 2.0–2.4).
 *
 * #167: ended the MCP stdio way — the client closes its stdin and the server
 * exits on its own, no signal, no `shutdown()`. Before #167 the SDK had no
 * hook on that path, and every event still queued (the flush interval is
 * 10 s) was lost without a line: 0 of 6 on MCP SDK v1 and v2.
 *
 * #174: stdout is the JSON-RPC wire, and the client reads every line there
 * as a message. Before #174 the SDK's informational lines went to stdout
 * (`console.info`), and the client got a parse error for each.
 */
import type { ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client as ClientV2 } from "@modelcontextprotocol/client";
import { StdioClientTransport as StdioClientV2 } from "@modelcontextprotocol/client/stdio";
import { Client as ClientV1 } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as StdioClientV1 } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MockIngest, startMockIngest } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "stdio-host.ts");
const SDK_DIR = join(here, "..", "..", "..");
const STACKS = ["v1", "v2"] as const;
type Stack = (typeof STACKS)[number];
type Mode = "plain" | "stdin-end" | "handle" | "sigint";
/** The MCP TypeScript clients send SIGTERM this long after closing stdin. */
const CLIENT_SIGTERM_MS = 2_000;

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Milliseconds from `client.close()` to the child's exit. */
  afterCloseMs: number;
}

/** A connected client and its server process. */
interface Wire {
  client: ClientV1 | ClientV2;
  proc: ChildProcess;
  /** Every byte the client read from the server's stdout, from the first one. */
  stdout: () => string;
  stderr: () => string;
  /** What the client reported through `onerror`: a parse error per non-JSON line on stdout. */
  clientErrors: unknown[];
  /** `client.close()`, timed: resolves with how long it took. */
  close: () => Promise<number>;
  exited: Promise<Exit>;
}

/** The `YAVIO-1205` lines of an output, as their event counts. */
const lossLines = (output: string): number[] =>
  [...output.matchAll(/YAVIO-1205\][^\n]*?(\d+) (?:more )?events not delivered/g)].map((m) =>
    Number(m[1]),
  );

describe.each(STACKS)("a stdio server on MCP SDK %s", (stack: Stack) => {
  let ingest: MockIngest;
  let spawned: ChildProcess[];

  beforeEach(async () => {
    spawned = [];
    ingest = await startMockIngest();
  });

  afterEach(async () => {
    for (const proc of spawned) {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }
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
        ENDPOINT: ingest.endpoint,
        STACK: stack,
        YAVIO_API_KEY: "",
        YAVIO_ENDPOINT: "",
        YAVIO_SHUTDOWN_TIMEOUT_MS: "",
        ...env,
      },
    };
    const transport = stack === "v2" ? new StdioClientV2(params) : new StdioClientV1(params);
    // Both stacks feed every stdout chunk to `_readBuffer.append`, created
    // in the constructor: hooked here, it sees the wire from its first
    // byte, before `connect()` returns (the mode lines come before the
    // initialize response).
    const chunks: Buffer[] = [];
    const readBuffer = (transport as unknown as { _readBuffer: { append(chunk: Buffer): void } })
      ._readBuffer;
    const append = readBuffer.append.bind(readBuffer);
    readBuffer.append = (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
      append(chunk);
    };
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    const client =
      stack === "v2"
        ? new ClientV2({ name: "stdio-test", version: "1.0.0" })
        : new ClientV1({ name: "stdio-test", version: "1.0.0" });
    const clientErrors: unknown[] = [];
    client.onerror = (error: unknown) => {
      clientErrors.push(error);
    };
    await client.connect(transport as never);
    // The client's own child: close() drops its reference.
    const proc = (transport as unknown as { _process: ChildProcess })._process;
    spawned.push(proc);
    let closedAt = 0;
    const exited = new Promise<Exit>((resolve) =>
      proc.once("exit", (code, signal) =>
        resolve({ code, signal, afterCloseMs: Date.now() - closedAt }),
      ),
    );
    return {
      client,
      proc,
      stdout: () => Buffer.concat(chunks).toString("utf8"),
      stderr: () => stderr,
      clientErrors,
      close: async () => {
        closedAt = Date.now();
        await client.close();
        return Date.now() - closedAt;
      },
      exited,
    };
  }

  async function call(wire: Wire, name: string, args: Record<string, unknown>): Promise<void> {
    const result = (await wire.client.callTool({ name, arguments: args })) as {
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
  }

  describe("ended by its client closing stdin (#167)", () => {
    interface Run {
      calls: number;
      /** How long `client.close()` took: under 2 s, the server exited before the client's SIGTERM. */
      closeMs: number;
      exit: Exit;
      output: string;
      lossLines: number[];
    }

    async function session(calls: number, mode: Mode = "plain"): Promise<Run> {
      const wire = await open({ MODE: mode });
      for (let i = 0; i < calls; i++) await call(wire, "echo", { q: `q${i}` });
      const closeMs = await wire.close();
      const exit = await wire.exited;
      const output = wire.stderr();
      return { calls, closeMs, exit, output, lossLines: lossLines(output) };
    }

    /** Every event of the session, each once: one connection, one tool_call per call. */
    function expectAllDelivered(run: Run) {
      expect(ingest.ofType("tool_call")).toHaveLength(run.calls);
      expect(ingest.ofType("connection")).toHaveLength(1);
      const ids = ingest.events.map((e) => e.event_id);
      expect(new Set(ids).size).toBe(ids.length);
    }

    /** Exited on its own (code 0, no signal) before the client's SIGTERM. */
    function expectNaturalExit(run: Run) {
      expect(run.exit, run.output).toMatchObject({ code: 0, signal: null });
      expect(run.closeMs).toBeLessThan(CLIENT_SIGTERM_MS);
    }

    it(
      "healthy ingest, 5 calls: all 6 events arrive before the process exits on its own",
      { timeout: 30_000 },
      async () => {
        const run = await session(5);
        expectNaturalExit(run);
        expectAllDelivered(run);
        expect(ingest.batches).toHaveLength(1); // nothing went out before the close
        expect(run.lossLines).toEqual([]);
      },
    );

    it(
      "150 calls, one full batch sent during the session: every event exactly once",
      { timeout: 30_000 },
      async () => {
        const run = await session(150);
        expectNaturalExit(run);
        expectAllDelivered(run);
        expect(ingest.events).toHaveLength(151);
        expect(run.lossLines).toEqual([]);
      },
    );

    it(
      "ingest answers the first batch with a 503: the retry delivers within the bound",
      { timeout: 30_000 },
      async () => {
        ingest.failNext = [503];
        const run = await session(5);
        expectNaturalExit(run);
        expect(ingest.batches.map((b) => b.status)).toEqual([503, 200]);
        expect(ingest.batches[1]?.events.map((e) => e.event_id)).toEqual(
          ingest.batches[0]?.events.map((e) => e.event_id),
        );
        expect(run.lossLines).toEqual([]);
      },
    );

    it(
      "hanging ingest: exits on its own at the 1.5 s bound, before the client's SIGTERM, with one counted line",
      { timeout: 30_000 },
      async () => {
        ingest.hangEvents = true;
        const run = await session(5);
        expectNaturalExit(run);
        expect(run.closeMs).toBeGreaterThanOrEqual(1_450);
        expect(run.lossLines).toEqual([6]);
        expect(run.output).toContain(
          "[YAVIO-1205] Exit deadline of 1500 ms reached — 6 events not delivered (the process ended on its own with events queued; queued, in flight or refused after the deadline). To wait longer, await analytics.shutdown() before the process ends.",
        );
      },
    );

    it(
      "idle (connected, no call): nothing sent, no line, no added delay",
      { timeout: 30_000 },
      async () => {
        const run = await session(0);
        expectNaturalExit(run);
        expect(run.closeMs).toBeLessThan(500);
        expect(ingest.batches).toHaveLength(0);
        expect(run.lossLines).toEqual([]);
      },
    );

    it(
      "the README recipe for a server with handles of its own (stdin end → shutdown() → exit): one drain, every event once, no line",
      { timeout: 30_000 },
      async () => {
        const run = await session(5, "stdin-end");
        expectNaturalExit(run);
        expectAllDelivered(run);
        expect(ingest.batches).toHaveLength(1);
        expect(run.lossLines).toEqual([]);
      },
    );

    it(
      "the README recipe against a hanging ingest: shutdownTimeoutMs 1 500 ends it before the client's SIGTERM, with its shutdown() line",
      { timeout: 30_000 },
      async () => {
        ingest.hangEvents = true;
        const run = await session(5, "stdin-end");
        expectNaturalExit(run);
        expect(run.closeMs).toBeGreaterThanOrEqual(1_450);
        expect(run.lossLines).toEqual([6]);
        expect(run.output).toContain(
          "[YAVIO-1205] shutdown() deadline of 1500 ms reached — 6 events not delivered.",
        );
      },
    );

    it(
      "a handle of the app's outlives the EOF by 1 s, ingest hanging: the client's SIGTERM during the drain takes it over without extending it — exit by SIGTERM at the natural deadline, one line",
      { timeout: 30_000 },
      async () => {
        ingest.hangEvents = true;
        const run = await session(5, "handle");
        // beforeExit at ~1 s, natural deadline ~2.5 s; SIGTERM at 2 s. Not 2 s + D.
        expect(run.exit, run.output).toMatchObject({ code: null, signal: "SIGTERM" });
        expect(run.exit.afterCloseMs).toBeGreaterThanOrEqual(2_400);
        expect(run.exit.afterCloseMs).toBeLessThan(3_200);
        expect(run.lossLines).toEqual([6]);
      },
    );
  });

  describe("stdout is the JSON-RPC wire (#174)", () => {
    /** One line of the wire: a JSON-RPC 2.0 message, or anything else. */
    const isJsonRpc = (line: string): boolean => {
      try {
        const message = JSON.parse(line) as { jsonrpc?: unknown } | null;
        return typeof message === "object" && message !== null && message.jsonrpc === "2.0";
      } catch {
        return false;
      }
    };

    it(
      "serverOnly and intent capture on, a widget-invoked tool, a SIGINT the app survives and a call after it: every line the client reads is JSON-RPC, and the SDK's lines are on stderr",
      { timeout: 30_000 },
      async () => {
        const wire = await open({ MODE: "sigint", INTENT: "1" });
        const { tools } = (await wire.client.listTools()) as { tools: Array<{ name: string }> };
        expect(tools.map((t) => t.name).sort()).toEqual(["echo", "widget_echo"]);
        await call(wire, "echo", { q: "a", context: "a test" });
        await call(wire, "widget_echo", { q: "b" });
        wire.proc.kill("SIGINT");
        // The app's listener runs after the SDK's (prepended): the signal was handled.
        await vi.waitFor(() => expect(wire.stderr()).toContain("[fixture] SIGINT"), {
          timeout: 5_000,
        });
        await call(wire, "echo", { q: "c", context: "after the signal" });
        await wire.close();
        const exit = await wire.exited;

        const lines = wire
          .stdout()
          .split("\n")
          .filter((line) => line.trim() !== "");
        expect(lines.filter((line) => !isJsonRpc(line))).toEqual([]);
        // The wire was read: initialize, tools/list and three calls answered.
        expect(lines.length).toBeGreaterThanOrEqual(5);
        expect(wire.clientErrors.map(String)).toEqual([]);
        // Not vacuous: each of the SDK's informational lines was printed — on stderr.
        for (const line of [
          "[yavio] Server-only mode: skipping _meta.yavio injection and widget token minting.",
          "[yavio] Intent capture enabled: tools advertise a 'context' parameter",
          '[yavio] Intent context advertised as OPTIONAL on widget-invoked tool "widget_echo"',
          "[yavio] Shutdown signal received — events from requests served from now on are sent at once, best effort.",
        ]) {
          expect(wire.stderr()).toContain(line);
        }
        // The call after the signal was tracked too, and the process ended on its own.
        await vi.waitFor(() => expect(ingest.ofType("tool_call")).toHaveLength(3));
        expect(exit, wire.stderr()).toMatchObject({ code: 0, signal: null });
      },
    );
  });
});
