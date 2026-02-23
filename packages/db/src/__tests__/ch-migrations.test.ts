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

    it("records all 8 migration versions", async () => {
      const ch = getClient();
      const result = await ch.query({
        query: "SELECT version FROM schema_migrations ORDER BY version",
        format: "JSONEachRow",
      });
      const versions = (await result.json<{ version: string }>()).map((r) => r.version);
      expect(versions).toEqual(["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008"]);
    });
  });

  describe("idempotent re-run", () => {
    it("running migrations a second time produces no errors", async () => {
      await expect(runMigrations()).resolves.not.toThrow();
    });
  });
});
