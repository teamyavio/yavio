import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

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
