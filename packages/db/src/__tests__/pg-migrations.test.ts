import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnect, getServiceDb, runMigrations } from "./helpers/pg.js";

describe("PostgreSQL migrations", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await disconnect();
  });

  describe("fresh migration — all tables created", () => {
    it("creates all 11 application tables", async () => {
      const { sql } = getServiceDb();
      const tables = await sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `;
      const names = tables.map((r) => r.table_name);
      const appTables = names.filter((n: string) => !n.startsWith("__"));
      expect(appTables).toHaveLength(11);
      expect(names).toEqual(
        expect.arrayContaining([
          "api_keys",
          "invitations",
          "login_attempts",
          "oauth_accounts",
          "projects",
          "sessions",
          "stripe_webhook_events",
          "users",
          "verification_tokens",
          "workspace_members",
          "workspaces",
        ]),
      );
    });
  });

  describe("indexes exist", () => {
    it("has all expected indexes", async () => {
      const { sql } = getServiceDb();
      const indexes = await sql`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
        ORDER BY indexname
      `;
      const indexNames = indexes.map((r) => r.indexname);

      expect(indexNames).toContain("idx_api_keys_hash");
      expect(indexNames).toContain("idx_api_keys_project");
      expect(indexNames).toContain("idx_api_keys_workspace");
      expect(indexNames).toContain("idx_sessions_token");
      expect(indexNames).toContain("idx_workspaces_slug");
      expect(indexNames).toContain("idx_projects_workspace");
      expect(indexNames).toContain("idx_workspace_members_user");
      expect(indexNames).toContain("idx_invitations_token");
      expect(indexNames).toContain("idx_invitations_email");
      expect(indexNames).toContain("idx_login_attempts_email");
      expect(indexNames).toContain("idx_login_attempts_cleanup");
      expect(indexNames).toContain("idx_verification_tokens_hash");
      expect(indexNames).toContain("idx_verification_tokens_user");
      expect(indexNames).toContain("idx_stripe_webhook_cleanup");
      expect(indexNames).toContain("projects_workspace_slug_unique");
      expect(indexNames).toContain("oauth_accounts_provider_account_unique");
      expect(indexNames).toContain("idx_workspaces_stripe_customer");
    });
  });

  describe("constraints valid", () => {
    it("has foreign key constraints", async () => {
      const { sql } = getServiceDb();
      const fks = await sql`
        SELECT constraint_name FROM information_schema.table_constraints
        WHERE constraint_type = 'FOREIGN KEY' AND table_schema = 'public'
        ORDER BY constraint_name
      `;
      const fkNames = fks.map((r) => r.constraint_name);
      expect(fkNames).toContain("api_keys_project_id_projects_id_fk");
      expect(fkNames).toContain("api_keys_workspace_id_workspaces_id_fk");
      expect(fkNames).toContain("sessions_user_id_users_id_fk");
      expect(fkNames).toContain("workspaces_owner_id_users_id_fk");
      expect(fkNames).toContain("workspace_members_workspace_id_workspaces_id_fk");
      expect(fkNames).toContain("workspace_members_user_id_users_id_fk");
      expect(fkNames).toContain("oauth_accounts_user_id_users_id_fk");
      expect(fkNames).toContain("projects_workspace_id_workspaces_id_fk");
      expect(fkNames).toContain("invitations_workspace_id_workspaces_id_fk");
      expect(fkNames).toContain("invitations_invited_by_users_id_fk");
      expect(fkNames).toContain("verification_tokens_user_id_users_id_fk");
    });
  });

  describe("RLS policies applied", () => {
    it("has RLS enabled on protected tables", async () => {
      const { sql } = getServiceDb();
      const rlsTables = await sql`
        SELECT relname FROM pg_class
        WHERE relrowsecurity = true AND relnamespace = 'public'::regnamespace
        ORDER BY relname
      `;
      const names = rlsTables.map((r) => r.relname);
      expect(names).toEqual(
        expect.arrayContaining([
          "api_keys",
          "invitations",
          "oauth_accounts",
          "projects",
          "sessions",
          "users",
          "workspace_members",
          "workspaces",
        ]),
      );
    });

    it("user_workspace_ids() function exists", async () => {
      const { sql } = getServiceDb();
      const fns = await sql`
        SELECT routine_name FROM information_schema.routines
        WHERE routine_schema = 'public' AND routine_name = 'user_workspace_ids'
      `;
      expect(fns).toHaveLength(1);
    });
  });

  describe("idempotent re-run", () => {
    it("running migrations a second time produces no errors", async () => {
      await expect(runMigrations()).resolves.not.toThrow();
    });
  });
});
