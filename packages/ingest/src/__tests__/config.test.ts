import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, parseRateLimits, parseTrustProxy } from "../config.js";

const REQUIRED = {
  DATABASE_URL: "postgres://yavio_service:pw@localhost:5432/yavio",
  CLICKHOUSE_URL: "http://default:pw@localhost:8123",
  API_KEY_HASH_SECRET: "hash-secret",
  JWT_SECRET: "jwt-secret",
};

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of [...Object.keys(REQUIRED), "PORT"]) {
    saved[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(REQUIRED)) {
    process.env[key] = value;
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

describe("loadConfig — ClickHouse least privilege", () => {
  it("connects as yavio_ingest, never as the default superuser", () => {
    // CLICKHOUSE_URL names `default` because migrations need DDL. Ingest must
    // narrow to the role granted only SELECT+INSERT on events and INSERT on
    // tool_registry, so a bug here cannot read another tenant or alter a table.
    const url = new URL(loadConfig().clickhouseUrl);
    expect(url.username).toBe("yavio_ingest");
    expect(url.username).not.toBe("default");
  });

  it("keeps host, port and password from the configured URL", () => {
    const url = new URL(loadConfig().clickhouseUrl);
    expect(url.hostname).toBe("localhost");
    expect(url.port).toBe("8123");
    // All ClickHouse users on a deployment share one password; only the
    // username is narrowed.
    expect(url.password).toBe("pw");
  });

  it("narrows the user whatever the URL already names", () => {
    process.env.CLICKHOUSE_URL = "http://someone_else:pw@ch.internal:8123";
    expect(new URL(loadConfig().clickhouseUrl).username).toBe("yavio_ingest");
  });

  it("uses the ingest user's OWN password when one is configured", () => {
    // Migration 0007 creates yavio_ingest with a literal published in the repo.
    // Once that user has its own secret, reusing the default user's password
    // (which setup-env.sh randomises) authenticates as the wrong identity.
    process.env.CLICKHOUSE_INGEST_PASSWORD = "ingest-only-secret";
    const url = new URL(loadConfig().clickhouseUrl);
    expect(url.username).toBe("yavio_ingest");
    expect(url.password).toBe("ingest-only-secret");
    Reflect.deleteProperty(process.env, "CLICKHOUSE_INGEST_PASSWORD");
  });

  it("falls back to the URL password when no per-user secret is set", () => {
    // Deployments where every ClickHouse user still shares one password must
    // keep working untouched.
    Reflect.deleteProperty(process.env, "CLICKHOUSE_INGEST_PASSWORD");
    const url = new URL(loadConfig().clickhouseUrl);
    expect(url.username).toBe("yavio_ingest");
    expect(url.password).toBe("pw");
  });

  it("leaves DATABASE_URL untouched", () => {
    expect(loadConfig().databaseUrl).toBe(REQUIRED.DATABASE_URL);
  });

  it("still reports a missing CLICKHOUSE_URL rather than a URL parse error", () => {
    // Assigning undefined would store the STRING "undefined" in process.env.
    Reflect.deleteProperty(process.env, "CLICKHOUSE_URL");
    expect(() => loadConfig()).toThrow(/CLICKHOUSE_URL is required/);
  });

  it("passes a malformed URL through so the existing validation reports it", () => {
    // Rewriting must not turn a bad value into an opaque URL parse crash.
    process.env.CLICKHOUSE_URL = "not-a-url";
    expect(loadConfig().clickhouseUrl).toBe("not-a-url");
  });
});

describe("TRUST_PROXY (#94)", () => {
  it("is empty when unset or blank", () => {
    expect(parseTrustProxy(undefined)).toEqual([]);
    expect(parseTrustProxy("  ")).toEqual([]);
  });

  it("accepts IP addresses and CIDR ranges, IPv4 and IPv6", () => {
    expect(parseTrustProxy("172.30.240.1, 172.30.241.0/24,::1,fd00::/8")).toEqual([
      "172.30.240.1",
      "172.30.241.0/24",
      "::1",
      "fd00::/8",
    ]);
  });

  it.each([
    "true",
    "*",
    "loopback",
    "uniquelocal",
    "300.1.1.1",
    "10.0.0.0/33",
    "10.0.0.1/8/1",
    "fd00::/129",
  ])("rejects %s — trusting more than the proxy lets clients forge their address", (value) => {
    expect(() => parseTrustProxy(value)).toThrow(/TRUST_PROXY/);
  });

  it("is read by loadConfig", () => {
    process.env.TRUST_PROXY = "172.30.240.1";
    try {
      expect(loadConfig().trustProxy).toEqual(["172.30.240.1"]);
    } finally {
      Reflect.deleteProperty(process.env, "TRUST_PROXY");
    }
  });
});

describe("rate limits from the environment", () => {
  it("are empty when nothing is set", () => {
    expect(parseRateLimits({})).toEqual({});
    expect(parseRateLimits({ RATE_LIMIT_WIDGET_TOKEN_BURST: "" })).toEqual({});
  });

  it("read the burst and the per-second rate of each widget bucket and the beacon bucket", () => {
    expect(
      parseRateLimits({
        RATE_LIMIT_WIDGET_TOKEN_BURST: "2000",
        RATE_LIMIT_WIDGET_TOKEN_PER_SECOND: "100",
        RATE_LIMIT_WIDGET_ADDRESS_BURST: "5000",
        RATE_LIMIT_WIDGET_ADDRESS_PER_SECOND: "500",
        RATE_LIMIT_WIDGET_PROJECT_PER_SECOND: "2500",
        RATE_LIMIT_BEACON_BURST: "200",
        RATE_LIMIT_BEACON_PER_SECOND: "0.5",
      }),
    ).toEqual({
      widgetToken: { burstCapacity: 2000, ratePerSecond: 100 },
      widgetAddress: { burstCapacity: 5000, ratePerSecond: 500 },
      widgetProject: { ratePerSecond: 2500 },
      beacon: { burstCapacity: 200, ratePerSecond: 0.5 },
    });
  });

  it("stop the start on anything but a positive number", () => {
    for (const raw of ["0", "-5", "abc", " ", "Infinity", "1e400"]) {
      expect(() => parseRateLimits({ RATE_LIMIT_BEACON_BURST: raw })).toThrow(
        "RATE_LIMIT_BEACON_BURST must be a positive number",
      );
    }
  });

  it("are read by loadConfig", () => {
    process.env.RATE_LIMIT_WIDGET_PROJECT_BURST = "20000";
    try {
      expect(loadConfig().rateLimits).toEqual({ widgetProject: { burstCapacity: 20000 } });
    } finally {
      Reflect.deleteProperty(process.env, "RATE_LIMIT_WIDGET_PROJECT_BURST");
    }
  });
});
