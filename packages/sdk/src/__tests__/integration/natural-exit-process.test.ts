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

describe.each(ENTRIES)("a process that ends on its own, %s", (entry) => {
  let ingest: MockIngest;

  beforeEach(async () => {
    ingest = await startMockIngest();
  });

  afterEach(async () => {
    await ingest.close();
  });

  function run(scenario: "cli" | "rearm" | "unref-tick"): Promise<Run> {
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
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    return new Promise((resolve) =>
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })),
    );
  }

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
});
