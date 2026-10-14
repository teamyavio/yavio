import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const created: Array<string | undefined> = [];
const createdWith: Array<unknown> = [];
const LONG_TIMEOUT = 3_600_000;

vi.mock("@yavio/db/clickhouse", () => ({
  LONG_RUNNING_REQUEST_TIMEOUT_MS: LONG_TIMEOUT,
  createClickHouseClient: (url?: string, options?: unknown) => {
    created.push(url);
    createdWith.push(options);
    return {} as never;
  },
}));

const ENV_KEYS = [
  "CLICKHOUSE_URL",
  "CLICKHOUSE_DASHBOARD_PASSWORD",
  "CLICKHOUSE_ERASER_PASSWORD",
] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  // Save ALL of them: a repo .env sets these, which previously turned a real
  // assertion into an environment-dependent flake.
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) Reflect.deleteProperty(process.env, k);
  created.length = 0;
  createdWith.length = 0;
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

async function urlFor(which: "read" | "mutate") {
  const mod = await import("@/lib/clickhouse");
  if (which === "read") mod.getClickHouseClient();
  else mod.getMutatingClickHouseClient();
  return created[0];
}

describe("read-only client — least privilege", () => {
  it("never opens a connection as the default superuser", async () => {
    process.env.CLICKHOUSE_URL = "http://default:pw@clickhouse:8123";
    const url = new URL((await urlFor("read")) as string);
    expect(url.username).toBe("yavio_dashboard");
  });

  it("keeps host, port and password", async () => {
    process.env.CLICKHOUSE_URL = "http://default:pw@clickhouse:8123";
    const url = new URL((await urlFor("read")) as string);
    expect(url.hostname).toBe("clickhouse");
    expect(url.port).toBe("8123");
    expect(url.password).toBe("pw");
  });

  it("passes a malformed URL through untouched", async () => {
    process.env.CLICKHOUSE_URL = "not-a-url";
    expect(await urlFor("read")).toBe("not-a-url");
  });
});

describe("mutating client — yavio_eraser only, never the superuser (#91)", () => {
  it("connects as yavio_eraser with its own password", async () => {
    // yavio_eraser holds ALTER DELETE on default.events and nothing else
    // (CH migration 0012). yavio_dashboard would fail with ACCESS_DENIED, and
    // `default` is the superuser this user exists to retire.
    process.env.CLICKHOUSE_URL = "http://default:pw@clickhouse:8123";
    process.env.CLICKHOUSE_ERASER_PASSWORD = "eraser-secret";
    const url = new URL((await urlFor("mutate")) as string);
    expect(url.username).toBe("yavio_eraser");
    expect(url.password).toBe("eraser-secret");
    expect(url.hostname).toBe("clickhouse");
    expect(url.port).toBe("8123");
    // Its deletes wait for their mutation; the 30 s default gave up on them.
    expect(createdWith[0]).toEqual({ requestTimeoutMs: LONG_TIMEOUT });
  });

  it("refuses to create a client without the eraser password instead of falling back", async () => {
    // The old fallback connected as the CLICKHOUSE_URL user — the superuser.
    process.env.CLICKHOUSE_URL = "http://default:pw@clickhouse:8123";
    const mod = await import("@/lib/clickhouse");
    expect(() => mod.getMutatingClickHouseClient()).toThrow(
      /CLICKHOUSE_ERASER_PASSWORD is not set/,
    );
    expect(created).toHaveLength(0);
  });

  it("is a different identity from the read-only client", async () => {
    process.env.CLICKHOUSE_URL = "http://default:pw@clickhouse:8123";
    process.env.CLICKHOUSE_ERASER_PASSWORD = "eraser-secret";
    const mod = await import("@/lib/clickhouse");
    mod.getClickHouseClient();
    mod.getMutatingClickHouseClient();
    const [readUrl, mutateUrl] = created;
    expect(new URL(readUrl as string).username).toBe("yavio_dashboard");
    expect(new URL(mutateUrl as string).username).toBe("yavio_eraser");
    expect(createdWith[0]).toBeUndefined(); // the read path keeps the default timeout
  });
});

describe("erasure is queued by the routes and done by the worker (#91 part 2)", () => {
  // The routes used to run ALTER TABLE events DELETE themselves, after the
  // Postgres rows were gone, inside a catch that logged and returned 200. Now
  // they delete and queue in one transaction (lib/erasure/requests) and kick
  // the worker, which alone talks to ClickHouse — as yavio_eraser. Assert the
  // wiring at the source level, so the next person cannot quietly go back to
  // erasing in the route or with the read-only client.
  const ROUTES: Array<[string, string]> = [
    ["app/api/auth/account/route.ts", "deleteAccountWithErasure"],
    ["app/api/workspaces/[workspaceId]/route.ts", "deleteWorkspaceWithErasure"],
    ["app/api/workspaces/[workspaceId]/projects/[projectId]/route.ts", "deleteProjectWithErasure"],
  ];

  for (const [rel, fn] of ROUTES) {
    it(`${rel} deletes through ${fn} and kicks the worker`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src).toContain(fn);
      expect(src).toContain("kickErasure()");
      expect(src).not.toMatch(/ALTER TABLE/);
      expect(src).not.toMatch(/\bgetClickHouseClient\b|getMutatingClickHouseClient/);
    });
  }

  it("the worker erases with the mutating client, never the read-only one", () => {
    const index = readFileSync(join(process.cwd(), "lib/erasure/index.ts"), "utf8");
    expect(index).toContain("clickhouse: getMutatingClickHouseClient");
    expect(index).not.toMatch(/\bgetClickHouseClient\b/);
    const worker = readFileSync(join(process.cwd(), "lib/erasure/worker.ts"), "utf8");
    expect(worker).toContain("ALTER TABLE ${table} DELETE WHERE");
  });
});
