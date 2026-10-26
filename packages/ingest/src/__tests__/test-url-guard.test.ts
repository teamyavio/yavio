import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isLocalHost,
  testClickHouseUrl,
  testDatabaseUrl,
} from "./integration/helpers/clickhouse-setup.js";

// The integration tests truncate and replace data: they refuse the
// development databases on this machine unless told otherwise.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isLocalHost", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "ch.localhost",
    "127.0.0.1",
    "127.0.0.2",
    "127.255.1.9",
    "127.1",
    "0.0.0.0",
    "0",
    "[::1]",
    "[::]",
    "[::ffff:7f00:1]",
    "[::ffff:127.0.0.1]",
  ])("takes %s as this machine", (host) => {
    expect(isLocalHost(host)).toBe(true);
  });

  it.each(["10.0.0.5", "128.0.0.1", "clickhouse", "ch.example.com", "[2001:db8::1]"])(
    "does not take %s as this machine",
    (host) => {
      expect(isLocalHost(host)).toBe(false);
    },
  );

  it("sees the hosts as URLs give them", () => {
    expect(isLocalHost(new URL("http://0.0.0.0:8123").hostname)).toBe(true);
    expect(isLocalHost(new URL("http://127.0.0.3:8123").hostname)).toBe(true);
    expect(isLocalHost(new URL("http://[::ffff:127.0.0.1]:8123").hostname)).toBe(true);
    expect(isLocalHost(new URL("postgres://u:p@127.1:5432/db").hostname)).toBe(true);
  });
});

describe("testClickHouseUrl", () => {
  it("refuses port 8123 on this machine outside CI", () => {
    vi.stubEnv("CI", "");
    vi.stubEnv("INGEST_TESTS_CLICKHOUSE_OK", "");
    for (const url of [
      "http://localhost:8123",
      "http://127.0.0.1:8123",
      "http://127.0.0.2:8123",
      "http://0.0.0.0:8123",
      "http://[::1]:8123",
    ]) {
      vi.stubEnv("CLICKHOUSE_URL", url);
      expect(() => testClickHouseUrl(), url).toThrow(/port 8123 on this machine/);
    }
  });

  it("takes another port, another host, CI or INGEST_TESTS_CLICKHOUSE_OK=1", () => {
    vi.stubEnv("CI", "");
    vi.stubEnv("INGEST_TESTS_CLICKHOUSE_OK", "");
    vi.stubEnv("CLICKHOUSE_URL", "http://127.0.0.1:18123");
    expect(testClickHouseUrl()).toBe("http://127.0.0.1:18123");
    vi.stubEnv("CLICKHOUSE_URL", "http://clickhouse:8123");
    expect(testClickHouseUrl()).toBe("http://clickhouse:8123");
    vi.stubEnv("CLICKHOUSE_URL", "http://localhost:8123");
    vi.stubEnv("CI", "true");
    expect(testClickHouseUrl()).toBe("http://localhost:8123");
    vi.stubEnv("CI", "");
    vi.stubEnv("INGEST_TESTS_CLICKHOUSE_OK", "1");
    expect(testClickHouseUrl()).toBe("http://localhost:8123");
  });

  it("requires CLICKHOUSE_URL", () => {
    vi.stubEnv("CLICKHOUSE_URL", "");
    expect(() => testClickHouseUrl()).toThrow(/Set CLICKHOUSE_URL/);
  });
});

describe("testDatabaseUrl", () => {
  it("refuses port 5432 or 5433 on this machine, or no port, outside CI", () => {
    vi.stubEnv("CI", "");
    vi.stubEnv("INGEST_TESTS_POSTGRES_OK", "");
    for (const url of [
      "postgres://u:p@localhost:5432/yavio_test",
      "postgres://u:p@127.0.0.1:5433/yavio_test",
      "postgres://u:p@0.0.0.0:5432/yavio_test",
      "postgres://u:p@[::1]:5432/yavio_test",
      "postgres://u:p@localhost/yavio_test",
    ]) {
      vi.stubEnv("DATABASE_URL", url);
      expect(() => testDatabaseUrl(), url).toThrow(/port 5432 or 5433 on this machine/);
    }
  });

  it("takes another port, CI or INGEST_TESTS_POSTGRES_OK=1, and requires DATABASE_URL", () => {
    vi.stubEnv("CI", "");
    vi.stubEnv("INGEST_TESTS_POSTGRES_OK", "");
    vi.stubEnv("DATABASE_URL", "postgres://u:p@127.0.0.1:15432/yavio_test");
    expect(testDatabaseUrl()).toBe("postgres://u:p@127.0.0.1:15432/yavio_test");
    vi.stubEnv("DATABASE_URL", "postgres://u:p@localhost:5432/yavio_test");
    vi.stubEnv("CI", "true");
    expect(testDatabaseUrl()).toBe("postgres://u:p@localhost:5432/yavio_test");
    vi.stubEnv("CI", "");
    vi.stubEnv("INGEST_TESTS_POSTGRES_OK", "1");
    expect(testDatabaseUrl()).toBe("postgres://u:p@localhost:5432/yavio_test");
    vi.stubEnv("DATABASE_URL", "");
    expect(() => testDatabaseUrl()).toThrow(/Set DATABASE_URL/);
  });
});
