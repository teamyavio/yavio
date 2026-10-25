/**
 * A process that ends on its own, in a real process (#167): a script or CLI
 * shape (`fixtures/cli-host.ts`), no signal, no `shutdown()`. Node emits
 * `beforeExit` once the loop has emptied, and again once whatever a
 * listener scheduled has settled; an unref'd timer fires only while
 * something else holds the loop. Only a real process shows both, so these
 * run as children.
 *
 * Review round 1 of #167: the process can go on after the SDK's
 * natural-exit drain and send through the proxies it already has — an app's
 * `beforeExit` listener that schedules more work, or an unref'd timer of the
 * app's firing while the drain holds the loop. Those events were dropped
 * without a line: the drain had taken the key out of the registry, and the
 * facade re-creates a transport only after a signal. Now such a send
 * re-enters the registry, and the next `beforeExit` drains it.
 *
 * Review round 2: the re-entry puts back the entry the drain took, with the
 * holds it had, so a `createYavio()` client's `shutdown()` afterwards
 * releases and stops the transport under its own deadline. Round 1's
 * re-entry was a new entry pinned by the SDK: the client's hold stayed
 * stale, its `shutdown()` only drained, and against a hanging ingest the
 * fetch kept the process up for the 30 s fetch timeout.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MockIngest, startMockIngest } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "cli-host.ts");
const SDK_DIR = join(here, "..", "..", "..");
const ENTRIES = ["with", "create"] as const;

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

type Scenario =
  | "cli"
  | "rearm"
  | "unref-tick"
  | "reenter-shutdown"
  | "late-client"
  | "reenter-exit";

/** Run the fixture to its exit; killed with SIGKILL after `killAfterMs`, so a process that stays up fails the test instead of timing it out. */
function runChild(
  ingest: MockIngest,
  entry: (typeof ENTRIES)[number],
  scenario: Scenario,
  env: Record<string, string> = {},
  killAfterMs = 20_000,
): Promise<Run> {
  const child = spawn(process.execPath, ["--import", "tsx", FIXTURE], {
    cwd: SDK_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ENDPOINT: ingest.endpoint,
      ENTRY: entry === "create" ? "create" : "with",
      SCENARIO: scenario,
      YAVIO_API_KEY: "",
      YAVIO_ENDPOINT: "",
      YAVIO_SHUTDOWN_TIMEOUT_MS: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const killer = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve) =>
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, stdout, stderr });
    }),
  );
}

/** The fixture's own clock: `[cli +<ms>] <line>`. */
const at = (stderr: string, line: string): number => {
  const match = new RegExp(`\\[cli \\+(\\d+)ms\\] ${line}`).exec(stderr);
  if (!match) throw new Error(`no "${line}" in:\n${stderr}`);
  return Number(match[1]);
};

describe.each(ENTRIES)("a process that ends on its own, %s", (entry) => {
  let ingest: MockIngest;

  beforeEach(async () => {
    ingest = await startMockIngest();
  });

  afterEach(async () => {
    await ingest.close();
  });

  const run = (scenario: Scenario) => runChild(ingest, entry, scenario);

  /** Every call's tool_call arrived, each event once; exit 0 on its own, no loss line, nothing on stdout. */
  function expectDelivered(result: Run, calls: string[]) {
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    const delivered = ingest.batches
      .filter((b) => b.status === 200)
      .flatMap((b) => b.events)
      .filter((e) => e.event_type === "tool_call")
      .map((e) => (e.input_values as { q: string }).q);
    expect(delivered.sort()).toEqual([...calls].sort());
    const ids = ingest.events.map((e) => e.event_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.stderr).not.toContain("YAVIO-1205");
    expect(result.stdout).toBe("");
  }

  it(
    "a script's 3 calls, nothing else: delivered before it exits (#167)",
    { timeout: 30_000 },
    async () => {
      const result = await run("cli");
      expectDelivered(result, ["q0", "q1", "q2"]);
    },
  );

  it(
    "an app's beforeExit listener schedules 2 more calls after each of two drains: each round re-enters, and the next beforeExit delivers it — drain → sends → drain → sends → drain (review round 1)",
    { timeout: 30_000 },
    async () => {
      const result = await run("rearm");
      expect(result.stderr).toContain("round 2: 2 late calls done");
      expectDelivered(result, ["q0", "q1", "q2", "late1a", "late1b", "late2a", "late2b"]);
      // One batch per pass: the first drain, then each round's.
      expect(ingest.batches.map((b) => b.status)).toEqual([200, 200, 200]);
    },
  );

  it(
    "an unref'd timer of the app's fires twice while the drain holds the loop: both calls are delivered by the next beforeExit (review round 1)",
    { timeout: 30_000 },
    async () => {
      ingest.respondAfterMs = 800; // the drain holds the loop past both ticks
      const result = await run("unref-tick");
      expect(result.stderr).toContain("tick 2 done");
      expectDelivered(result, ["q0", "q1", "q2", "tick1", "tick2"]);
    },
  );

  it(
    "after the drain the app creates a second createYavio() client on the key and shuts it down: the first proxy's next call is still delivered by the next beforeExit (review round 3)",
    { timeout: 30_000 },
    async () => {
      const result = await run("late-client");
      expect(result.stderr).toContain("late client shut down, 1 more call done");
      // Before round 3 the late client's hold was on a new entry, its
      // shutdown() stopped it, and this call vanished without a line.
      expectDelivered(result, ["q0", "q1", "q2", "after-late-client"]);
    },
  );
});

describe("a createYavio() client whose app ends with await shutdown() after a re-entry (review round 2)", () => {
  let ingest: MockIngest;

  beforeEach(async () => {
    ingest = await startMockIngest();
  });

  afterEach(async () => {
    await ingest.answerHung();
    await ingest.close();
  });

  it(
    "ingest answers the first drain, then hangs: shutdown() releases the re-entered transport and stops it at its own deadline — the fetch aborted, its shutdown() line, exit within D + 0.5 s, no Exit deadline line",
    { timeout: 30_000 },
    async () => {
      // The first batch is answered; every later one hangs.
      ingest.respondAfterMs = () => {
        ingest.hangEvents = true;
        return 0;
      };
      const result = await runChild(ingest, "create", "reenter-shutdown", {
        YAVIO_SHUTDOWN_TIMEOUT_MS: "1000",
      });

      // Round 1: the stale hold only drained, the hanging fetch kept its
      // socket, and the process stayed up for the 30 s fetch timeout
      // (killed here at 20 s).
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      const afterShutdown = at(result.stderr, "exit 0") - at(result.stderr, "late call done");
      expect(afterShutdown).toBeGreaterThanOrEqual(950);
      expect(afterShutdown).toBeLessThan(1_500); // D + 0.5 s
      expect(result.stderr).toContain(
        "[YAVIO-1205] shutdown() deadline of 1000 ms reached — 1 events not delivered.",
      );
      expect(result.stderr).not.toContain("Exit deadline");
      expect(ingest.batches.map((b) => b.status)).toEqual([200, undefined]); // the late batch hung
    },
  );
});

describe.each(ENTRIES)(
  "an app that ends with await shutdown(); process.exit(0) after a natural-exit drain, %s (#178 follow-up)",
  (entry) => {
    let ingest: MockIngest;

    beforeEach(async () => {
      ingest = await startMockIngest();
    });

    afterEach(async () => {
      await ingest.answerHung();
      await ingest.close();
    });

    it(
      "ingest answers the drain, then hangs: the stop's shutdown() line comes before shutdown() returns, so the exit right after it prints nothing else",
      { timeout: 30_000 },
      async () => {
        ingest.respondAfterMs = () => {
          ingest.hangEvents = true; // every later batch hangs
          return 0;
        };
        const result = await runChild(ingest, entry, "reenter-exit", {
          YAVIO_SHUTDOWN_TIMEOUT_MS: "600",
        });

        expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
        // Before: the release awaited the drain that had settled long ago, its
        // stop armed its deadline timer after the shutdown() wait's, the wait
        // returned first, and process.exit(0) printed "Exit deadline of 600 ms
        // reached — 1 events not delivered (the process ended on its own …)".
        const lines = [...result.stderr.matchAll(/\[YAVIO-1205\][^\n]*/g)].map((m) => m[0]);
        expect(lines, result.stderr).toEqual([
          "[YAVIO-1205] shutdown() deadline of 600 ms reached — 1 events not delivered. Raise shutdownTimeoutMs (or YAVIO_SHUTDOWN_TIMEOUT_MS) if the platform's grace period allows.",
        ]);
        expect(at(result.stderr, "exit 0") - at(result.stderr, "late call done")).toBeLessThan(
          1_100,
        );
      },
    );
  },
);
