import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The issue (#91) is explicit that testing the client factory alone would pass
// while the real bug — a deployment that boots without the eraser credential —
// is still there. So: register() itself, and the built standalone server.

// DATABASE_URL too: with it, register() also starts the erasure worker (#91 part 2).
const KEYS = ["CLICKHOUSE_ERASER_PASSWORD", "NEXT_RUNTIME", "NEXT_PHASE", "DATABASE_URL"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) Reflect.deleteProperty(process.env, k);
  vi.resetModules();
});

afterEach(() => {
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

function spyExit() {
  return vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
}

describe("instrumentation register()", () => {
  it("exits with status 1 and names the variable when CLICKHOUSE_ERASER_PASSWORD is missing", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const exit = spyExit();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { register } = await import("@/instrumentation");
    await register();
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls.flat().join(" ")).toContain("CLICKHOUSE_ERASER_PASSWORD is not set");
  });

  it("starts normally when the variable is set", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.CLICKHOUSE_ERASER_PASSWORD = "eraser-secret";
    const exit = spyExit();
    const { register } = await import("@/instrumentation");
    await register();
    expect(exit).not.toHaveBeenCalled();
  });

  it("does not check during `next build`, which holds no runtime secrets", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.NEXT_PHASE = "phase-production-build";
    const exit = spyExit();
    const { register } = await import("@/instrumentation");
    await register();
    expect(exit).not.toHaveBeenCalled();
  });

  it("does nothing in the edge runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    const exit = spyExit();
    const { register } = await import("@/instrumentation");
    await register();
    expect(exit).not.toHaveBeenCalled();
  });
});

// CI builds the dashboard before running these tests (ci.yml, test-dashboard),
// so the standalone server is there. Locally it exists only after
// `pnpm --filter @yavio/dashboard build`; outside CI the suite is skipped
// rather than failed, and says so.
const SERVER = join(process.cwd(), ".next", "standalone", "packages", "dashboard", "server.js");
const built = existsSync(SERVER);
if (!built && process.env.CI) {
  throw new Error(`standalone build missing at ${SERVER}; CI must build before testing`);
}

function startServer(env: Record<string, string>, port: number): ChildProcess {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1" };
  for (const k of KEYS) Reflect.deleteProperty(childEnv, k);
  Object.assign(childEnv, env);
  return spawn(process.execPath, [SERVER], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
}

function collect(child: ChildProcess): () => string {
  let out = "";
  child.stdout?.on("data", (d) => {
    out += String(d);
  });
  child.stderr?.on("data", (d) => {
    out += String(d);
  });
  return () => out;
}

describe.skipIf(!built)("standalone server (built output)", () => {
  it("refuses to start without CLICKHOUSE_ERASER_PASSWORD", async () => {
    const child = startServer({}, 3917);
    const output = collect(child);
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(null);
      }, 30_000);
      child.on("exit", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    expect(code).toBe(1);
    expect(output()).toContain("CLICKHOUSE_ERASER_PASSWORD is not set");
  }, 40_000);

  it("serves requests when the variable is set", async () => {
    const port = 3918;
    const child = startServer({ CLICKHOUSE_ERASER_PASSWORD: "eraser-secret" }, port);
    let exitCode: number | null | undefined;
    child.on("exit", (c) => {
      exitCode = c;
    });
    try {
      let status = 0;
      for (let i = 0; i < 60 && status === 0 && exitCode === undefined; i++) {
        await new Promise((r) => setTimeout(r, 500));
        status = await fetch(`http://127.0.0.1:${port}/login`)
          .then((r) => r.status)
          .catch(() => 0);
      }
      expect(exitCode).toBeUndefined();
      expect(status).toBe(200);
    } finally {
      child.kill("SIGTERM");
    }
  }, 40_000);
});
