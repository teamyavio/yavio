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

let saved: string | undefined;

beforeEach(() => {
  saved = process.env.CLICKHOUSE_URL;
  created.length = 0;
  vi.resetModules();
});

afterEach(() => {
  if (saved === undefined) Reflect.deleteProperty(process.env, "CLICKHOUSE_URL");
  else process.env.CLICKHOUSE_URL = saved;
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

describe("mutating client — must retain ALTER DELETE rights", () => {
  it("does NOT narrow the user, because erasure needs privileges yavio_dashboard lacks", async () => {
    // Regression guard for b3fd7e7. yavio_dashboard is granted SELECT on four
    // tables (migration 0010); ALTER TABLE ... DELETE fails for it with
    // ACCESS_DENIED. Narrowing this client silently broke every account,
    // workspace and project erasure while the routes still returned 200.
    process.env.CLICKHOUSE_URL = "http://default:pw@clickhouse:8123";
    const url = new URL((await urlFor("mutate")) as string);
    expect(url.username).toBe("default");
    expect(url.username).not.toBe("yavio_dashboard");
  });

  it("is a different identity from the read-only client", async () => {
    process.env.CLICKHOUSE_URL = "http://default:pw@clickhouse:8123";
    const mod = await import("@/lib/clickhouse");
    mod.getClickHouseClient();
    mod.getMutatingClickHouseClient();
    const [readUrl, mutateUrl] = created;
    expect(new URL(readUrl as string).username).not.toBe(new URL(mutateUrl as string).username);
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
