import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const created: Array<string | undefined> = [];

vi.mock("@yavio/db/clickhouse", () => ({
  createClickHouseClient: (url?: string) => {
    created.push(url);
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
  });
});

describe("erasure routes wire to the mutating client", () => {
  // These routes reach the module through a DYNAMIC import
  // (`await import("@/lib/clickhouse")`), so a static grep for
  // `from "@/lib/clickhouse"` does not find them — which is exactly how the
  // regression shipped. Assert the wiring at the source level so the next
  // person cannot repeat it.
  const ROUTES = [
    "app/api/auth/account/route.ts",
    "app/api/workspaces/[workspaceId]/route.ts",
    "app/api/workspaces/[workspaceId]/projects/[projectId]/route.ts",
  ];

  for (const rel of ROUTES) {
    it(`${rel} uses the mutating client, not the read-only one`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src).toContain("ALTER TABLE events DELETE");
      expect(src).toContain("getMutatingClickHouseClient");
      // The read-only accessor must not appear at all — matching on the exact
      // identifier, since getMutatingClickHouseClient does not contain it.
      expect(src).not.toMatch(/\bgetClickHouseClient\b/);
    });
  }
});
