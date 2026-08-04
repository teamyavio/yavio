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

async function loadClient() {
  const mod = await import("@/lib/clickhouse");
  mod.getClickHouseClient();
  return created[0];
}

describe("getClickHouseClient — least privilege", () => {
  it("never opens a connection as the default superuser", async () => {
    // CLICKHOUSE_URL names `default` because migrations need DDL. This client
    // only runs SELECT 1 for the health check, so it must narrow.
    process.env.CLICKHOUSE_URL = "http://default:pw@clickhouse:8123";
    const url = new URL((await loadClient()) as string);
    expect(url.username).toBe("yavio_dashboard");
    expect(url.username).not.toBe("default");
  });

  it("keeps host, port and password", async () => {
    process.env.CLICKHOUSE_URL = "http://default:pw@clickhouse:8123";
    const url = new URL((await loadClient()) as string);
    expect(url.hostname).toBe("clickhouse");
    expect(url.port).toBe("8123");
    expect(url.password).toBe("pw");
  });

  it("narrows whatever user the URL already names", async () => {
    process.env.CLICKHOUSE_URL = "http://someone_else:pw@clickhouse:8123";
    const url = new URL((await loadClient()) as string);
    expect(url.username).toBe("yavio_dashboard");
  });

  it("passes a malformed URL through untouched", async () => {
    // Must not convert a bad value into an opaque URL parse crash.
    process.env.CLICKHOUSE_URL = "not-a-url";
    expect(await loadClient()).toBe("not-a-url");
  });
});
