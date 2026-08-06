import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertNoPasswordlessUsers,
  readManagedUserAuth,
  repairPasswordlessUsers,
} from "../clickhouse-credentials.js";
import { MANAGED_USER_NAMES, UNUSABLE_PASSWORD_HASH } from "../migrate-clickhouse-helpers.js";
import { disconnect, dropAll, getClient, runMigrations } from "./helpers/clickhouse.js";

/**
 * The HTTP endpoint with any userinfo stripped, so the tests below can present
 * their own credentials. Authenticating over the wire is the only way to show
 * what `no_password` really does — system.users reports the method, not the
 * behaviour, and it was a belief about the behaviour that shipped the defect.
 */
const CLICKHOUSE_HTTP = (() => {
  const url = new URL(process.env.CLICKHOUSE_URL ?? "http://localhost:8123");
  url.username = "";
  url.password = "";
  return url.toString();
})();

/**
 * Try to authenticate as yavio_eraser over HTTP and report what came back.
 *
 * Reads the BODY, not just the status. ClickHouse answers a rejected credential
 * with HTTP 403 and puts `Code: 516 ... Authentication failed` in the body, so
 * asserting on a 516 status would be an assertion that can never fail — which
 * is the whole failure mode this test file exists to close.
 */
async function attemptAuth(password: string): Promise<{ status: number; body: string }> {
  const res = await fetch(CLICKHOUSE_HTTP, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`yavio_eraser:${password}`).toString("base64")}`,
    },
    body: "SELECT 1 FORMAT TSV",
  });
  return { status: res.status, body: await res.text() };
}

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

    it("records all 12 migration versions", async () => {
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
      ]);
    });
  });

  describe("credentials fail closed", () => {
    // The test environment sets no CLICKHOUSE_*_PASSWORD, so this exercises the
    // exact path that shipped the defect: migrations run, no password is
    // applied, and the accounts must still be unreachable.
    //
    // These call the SHIPPED functions rather than re-implementing their
    // predicates. A test that reproduces the logic it is checking proves the
    // database state and nothing about the code that is supposed to enforce it.
    it("leaves no managed user authenticating without a credential", async () => {
      await expect(assertNoPasswordlessUsers(getClient(), true)).resolves.not.toThrow();
    });

    it("sees every managed user, so the assertion above cannot pass vacuously", async () => {
      const auth = await readManagedUserAuth(getClient());
      expect([...auth.keys()].sort()).toEqual([...MANAGED_USER_NAMES].sort());
    });

    it("grants yavio_eraser row deletion on events and nothing else", async () => {
      const ch = getClient();
      const grants = await ch.query({
        query:
          "SELECT access_type, database, table, grant_option FROM system.grants WHERE user_name = 'yavio_eraser' ORDER BY access_type",
        format: "JSONEachRow",
      });
      expect(await grants.json()).toEqual([
        { access_type: "ALTER DELETE", database: "default", table: "events", grant_option: 0 },
      ]);

      // Direct grants are only half the picture: a role would carry its own
      // privileges in, and "nothing else" has to mean that too.
      const roles = await ch.query({
        query: "SELECT granted_role_name FROM system.role_grants WHERE user_name = 'yavio_eraser'",
        format: "JSONEachRow",
      });
      expect(await roles.json()).toEqual([]);
    });
  });

  describe("repair of an already-passwordless user", () => {
    // The upgrade path is the whole reason repairPasswordlessUsers exists, and
    // CI always starts from a fresh container where migration 0012 alone
    // satisfies every assertion above. Without this, deleting the repair
    // entirely would leave the suite green.
    beforeAll(async () => {
      const ch = getClient();
      await ch.command({ query: "DROP USER IF EXISTS yavio_eraser" });
      // Exactly what migration 0012 shipped before it was amended.
      await ch.command({ query: "CREATE USER yavio_eraser IDENTIFIED WITH no_password" });
      await ch.command({ query: "GRANT ALTER DELETE ON default.events TO yavio_eraser" });
    });

    it("reproduces the defect: the account authenticates with a WRONG password", async () => {
      // Not a rhetorical step. `no_password` reads like "cannot log in", and
      // the whole defect was believing that. This pins the real behaviour.
      const { status, body } = await attemptAuth("definitely-not-the-password");
      expect(status).toBe(200);
      expect(body).not.toMatch(/Authentication failed/);
    });

    it("detects it", async () => {
      await expect(assertNoPasswordlessUsers(getClient(), true)).rejects.toThrow(
        /authenticate with NO credential/,
      );
    });

    it("repairs it, and reports which user it repaired", async () => {
      await expect(repairPasswordlessUsers(getClient())).resolves.toEqual(["yavio_eraser"]);
      await expect(assertNoPasswordlessUsers(getClient(), true)).resolves.not.toThrow();
    });

    it("leaves the repaired account unauthenticatable — including by its own published hash", async () => {
      for (const password of ["", "definitely-not-the-password", UNUSABLE_PASSWORD_HASH]) {
        const { status, body } = await attemptAuth(password);
        expect(status).toBe(403);
        // Presenting the published digest itself must fail too — that is what
        // makes it safe to ship the constant in a public repository.
        expect(body).toMatch(/Authentication failed/);
      }
    });

    it("preserves the grant, so a real password still yields a working eraser", async () => {
      const result = await getClient().query({
        query:
          "SELECT access_type FROM system.grants WHERE user_name = 'yavio_eraser' AND table = 'events'",
        format: "JSONEachRow",
      });
      expect(await result.json()).toEqual([{ access_type: "ALTER DELETE" }]);
    });

    it("is a no-op on a user that already holds a real password", async () => {
      const ch = getClient();
      await ch.command({
        query: "ALTER USER yavio_eraser IDENTIFIED WITH sha256_password BY 'a-working-password'",
      });
      // The destructive version of this repair lived in a migration and reset
      // every deployment's credential unconditionally. A broken eraser fails
      // silently — the deletion routes log and still return 200 — so "does not
      // touch a working account" is the property that matters most here.
      await expect(repairPasswordlessUsers(ch)).resolves.toEqual([]);

      const { status, body } = await attemptAuth("a-working-password");
      expect(status).toBe(200);
      expect(body).not.toMatch(/Authentication failed/);
    });
  });

  describe("idempotent re-run", () => {
    it("running migrations a second time produces no errors", async () => {
      await expect(runMigrations()).resolves.not.toThrow();
    });
  });
});
