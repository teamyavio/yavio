import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnect, dropAll, getClient, runMigrations } from "./helpers/clickhouse.js";

describe("ClickHouse migrations", () => {
  beforeAll(async () => {
    await dropAll().catch(() => {}); // Ignore errors if tables don't exist yet
    await runMigrations();
  });

  afterAll(async () => {
    await disconnect();
  });

  describe("fresh migration — all objects created", () => {
    it("creates the events table", async () => {
      const ch = getClient();
      const result = await ch.query({
        query: "SELECT name FROM system.tables WHERE database = 'default' AND name = 'events'",
        format: "JSONEachRow",
      });
      expect(await result.json()).toHaveLength(1);
    });

    it("creates sessions_mv materialized view", async () => {
      const ch = getClient();
      const result = await ch.query({
        query:
          "SELECT name FROM system.tables WHERE database = 'default' AND name = 'sessions_mv' AND engine = 'MaterializedView'",
        format: "JSONEachRow",
      });
      expect(await result.json()).toHaveLength(1);
    });

    it("creates users_mv materialized view", async () => {
      const ch = getClient();
      const result = await ch.query({
        query:
          "SELECT name FROM system.tables WHERE database = 'default' AND name = 'users_mv' AND engine = 'MaterializedView'",
        format: "JSONEachRow",
      });
      expect(await result.json()).toHaveLength(1);
    });

    it("creates tool_registry table", async () => {
      const ch = getClient();
      const result = await ch.query({
        query:
          "SELECT name FROM system.tables WHERE database = 'default' AND name = 'tool_registry'",
        format: "JSONEachRow",
      });
      expect(await result.json()).toHaveLength(1);
    });

    it("creates schema_migrations table", async () => {
      const ch = getClient();
      const result = await ch.query({
        query:
          "SELECT name FROM system.tables WHERE database = 'default' AND name = 'schema_migrations'",
        format: "JSONEachRow",
      });
      expect(await result.json()).toHaveLength(1);
    });

    it("records all 13 migration versions", async () => {
      const ch = getClient();
      const result = await ch.query({
        query: "SELECT version FROM schema_migrations ORDER BY version",
        format: "JSONEachRow",
      });
      const versions = (await result.json<{ version: string }>()).map((r) => r.version);
      expect(versions).toEqual([
        "0001",
        "0002",
        "0003",
        "0004",
        "0005",
        "0006",
        "0007",
        "0008",
        "0009",
        "0010",
        "0011",
        "0012",
        "0013",
      ]);
    });
  });

  describe("credentials fail closed", () => {
    // The test environment sets no CLICKHOUSE_*_PASSWORD, so this exercises the
    // exact path that shipped the defect: migrations run, no password is
    // applied, and the accounts must still be unreachable.
    it("leaves no managed user authenticating without a credential", async () => {
      const ch = getClient();
      const result = await ch.query({
        query:
          "SELECT name, auth_type FROM system.users WHERE name IN ('yavio_ingest', 'yavio_dashboard', 'yavio_eraser')",
        format: "JSONEachRow",
      });
      const rows = await result.json<{ name: string; auth_type: string | string[] }>();

      // `no_password` in ClickHouse is not "cannot log in" — it is "no
      // credential required", and it accepts a wrong password too. 0012 shipped
      // yavio_eraser in that state holding ALTER DELETE on the events table.
      const passwordless = rows
        .filter(({ auth_type }) =>
          (Array.isArray(auth_type) ? auth_type : [auth_type]).includes("no_password"),
        )
        .map(({ name }) => name);
      expect(passwordless).toEqual([]);
    });

    it("creates yavio_eraser, so the assertion above is not passing vacuously", async () => {
      const ch = getClient();
      const result = await ch.query({
        query: "SELECT name FROM system.users WHERE name = 'yavio_eraser'",
        format: "JSONEachRow",
      });
      expect(await result.json()).toHaveLength(1);
    });

    it("grants yavio_eraser row deletion on events and nothing else", async () => {
      const ch = getClient();
      const result = await ch.query({
        query:
          "SELECT access_type, database, table FROM system.grants WHERE user_name = 'yavio_eraser' ORDER BY access_type",
        format: "JSONEachRow",
      });
      expect(await result.json()).toEqual([
        { access_type: "ALTER DELETE", database: "default", table: "events" },
      ]);
    });
  });

  describe("idempotent re-run", () => {
    it("running migrations a second time produces no errors", async () => {
      await expect(runMigrations()).resolves.not.toThrow();
    });
  });
});
