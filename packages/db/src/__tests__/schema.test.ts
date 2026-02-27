import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../schema.js";

describe("schema tables", () => {
  it("exports all 11 tables", () => {
    const tables = [
      schema.users,
      schema.oauthAccounts,
      schema.sessions,
      schema.workspaces,
      schema.workspaceMembers,
      schema.invitations,
      schema.projects,
      schema.apiKeys,
      schema.verificationTokens,
      schema.loginAttempts,
      schema.stripeWebhookEvents,
    ];
    expect(tables).toHaveLength(11);
    for (const table of tables) {
      expect(getTableName(table)).toBeTruthy();
    }
  });

  it("users table has correct SQL name and columns", () => {
    expect(getTableName(schema.users)).toBe("users");
    const config = getTableConfig(schema.users);
    const colNames = config.columns.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("email");
    expect(colNames).toContain("name");
    expect(colNames).toContain("password_hash");
    expect(colNames).toContain("avatar_url");
    expect(colNames).toContain("email_verified");
    expect(colNames).toContain("created_at");
    expect(colNames).toContain("updated_at");
  });

  it("oauth_accounts table has provider and account id columns", () => {
    expect(getTableName(schema.oauthAccounts)).toBe("oauth_accounts");
    const config = getTableConfig(schema.oauthAccounts);
    const colNames = config.columns.map((c) => c.name);
    expect(colNames).toContain("provider");
    expect(colNames).toContain("provider_account_id");
    expect(colNames).toContain("user_id");
  });

  it("sessions table has token and expiry columns", () => {
    expect(getTableName(schema.sessions)).toBe("sessions");
    const config = getTableConfig(schema.sessions);
    const colNames = config.columns.map((c) => c.name);
    expect(colNames).toContain("token");
    expect(colNames).toContain("expires_at");
    expect(colNames).toContain("user_id");
  });

  it("workspaces table has slug and billing columns", () => {
    expect(getTableName(schema.workspaces)).toBe("workspaces");
    const config = getTableConfig(schema.workspaces);
    const colNames = config.columns.map((c) => c.name);
    expect(colNames).toContain("slug");
    expect(colNames).toContain("owner_id");
    expect(colNames).toContain("plan");
    expect(colNames).toContain("stripe_customer_id");
    expect(colNames).toContain("spending_cap");
    expect(colNames).toContain("billing_status");
  });

  it("workspace_members table has composite primary key columns", () => {
    expect(getTableName(schema.workspaceMembers)).toBe("workspace_members");
    const config = getTableConfig(schema.workspaceMembers);
    const colNames = config.columns.map((c) => c.name);
    expect(colNames).toContain("workspace_id");
    expect(colNames).toContain("user_id");
    expect(colNames).toContain("role");
  });

  it("invitations table has token and expiry columns", () => {
    expect(getTableName(schema.invitations)).toBe("invitations");
    const config = getTableConfig(schema.invitations);
    const colNames = config.columns.map((c) => c.name);
    expect(colNames).toContain("email");
    expect(colNames).toContain("role");
    expect(colNames).toContain("token");
    expect(colNames).toContain("expires_at");
    expect(colNames).toContain("invited_by");
  });

  it("projects table has workspace-scoped slug", () => {
    expect(getTableName(schema.projects)).toBe("projects");
    const config = getTableConfig(schema.projects);
    const colNames = config.columns.map((c) => c.name);
    expect(colNames).toContain("workspace_id");
    expect(colNames).toContain("slug");
    expect(colNames).toContain("name");
  });

  it("api_keys table has hash and prefix columns", () => {
    expect(getTableName(schema.apiKeys)).toBe("api_keys");
    const config = getTableConfig(schema.apiKeys);
    const colNames = config.columns.map((c) => c.name);
    expect(colNames).toContain("key_hash");
    expect(colNames).toContain("key_prefix");
    expect(colNames).toContain("project_id");
    expect(colNames).toContain("workspace_id");
    expect(colNames).toContain("revoked_at");
  });

  it("verification_tokens table has hash and type columns", () => {
    expect(getTableName(schema.verificationTokens)).toBe("verification_tokens");
    const config = getTableConfig(schema.verificationTokens);
    const colNames = config.columns.map((c) => c.name);
    expect(colNames).toContain("token_hash");
    expect(colNames).toContain("type");
    expect(colNames).toContain("user_id");
    expect(colNames).toContain("expires_at");
    expect(colNames).toContain("used_at");
  });

  it("login_attempts table has email and IP columns", () => {
    expect(getTableName(schema.loginAttempts)).toBe("login_attempts");
    const config = getTableConfig(schema.loginAttempts);
    const colNames = config.columns.map((c) => c.name);
    expect(colNames).toContain("email");
    expect(colNames).toContain("ip_address");
  });

  it("stripe_webhook_events table has event_id primary key", () => {
    expect(getTableName(schema.stripeWebhookEvents)).toBe("stripe_webhook_events");
    const config = getTableConfig(schema.stripeWebhookEvents);
    const colNames = config.columns.map((c) => c.name);
    expect(colNames).toContain("event_id");
    expect(colNames).toContain("event_type");
    expect(colNames).toContain("processed_at");
  });
});

describe("schema foreign keys", () => {
  it("oauth_accounts references users", () => {
    const config = getTableConfig(schema.oauthAccounts);
    expect(config.foreignKeys).toHaveLength(1);
    const ref = config.foreignKeys[0].reference();
    expect(getTableName(ref.foreignTable)).toBe("users");
  });

  it("sessions references users", () => {
    const config = getTableConfig(schema.sessions);
    expect(config.foreignKeys).toHaveLength(1);
    const ref = config.foreignKeys[0].reference();
    expect(getTableName(ref.foreignTable)).toBe("users");
  });

  it("workspace_members references workspaces and users", () => {
    const config = getTableConfig(schema.workspaceMembers);
    expect(config.foreignKeys).toHaveLength(2);
    const tableNames = config.foreignKeys.map((fk) => getTableName(fk.reference().foreignTable));
    expect(tableNames).toContain("workspaces");
    expect(tableNames).toContain("users");
  });

  it("invitations references workspaces and users", () => {
    const config = getTableConfig(schema.invitations);
    expect(config.foreignKeys).toHaveLength(2);
    const tableNames = config.foreignKeys.map((fk) => getTableName(fk.reference().foreignTable));
    expect(tableNames).toContain("workspaces");
    expect(tableNames).toContain("users");
  });

  it("projects references workspaces", () => {
    const config = getTableConfig(schema.projects);
    expect(config.foreignKeys).toHaveLength(1);
    const ref = config.foreignKeys[0].reference();
    expect(getTableName(ref.foreignTable)).toBe("workspaces");
  });

  it("api_keys references projects and workspaces", () => {
    const config = getTableConfig(schema.apiKeys);
    expect(config.foreignKeys).toHaveLength(2);
    const tableNames = config.foreignKeys.map((fk) => getTableName(fk.reference().foreignTable));
    expect(tableNames).toContain("projects");
    expect(tableNames).toContain("workspaces");
  });

  it("verification_tokens references users", () => {
    const config = getTableConfig(schema.verificationTokens);
    expect(config.foreignKeys).toHaveLength(1);
    const ref = config.foreignKeys[0].reference();
    expect(getTableName(ref.foreignTable)).toBe("users");
  });
});

describe("schema indexes", () => {
  it("workspaces has slug index", () => {
    const config = getTableConfig(schema.workspaces);
    const indexNames = config.indexes.map((i) => i.config.name);
    expect(indexNames).toContain("idx_workspaces_slug");
  });

  it("api_keys has hash, project, and workspace indexes", () => {
    const config = getTableConfig(schema.apiKeys);
    const indexNames = config.indexes.map((i) => i.config.name);
    expect(indexNames).toContain("idx_api_keys_hash");
    expect(indexNames).toContain("idx_api_keys_project");
    expect(indexNames).toContain("idx_api_keys_workspace");
  });

  it("projects has workspace-slug unique index", () => {
    const config = getTableConfig(schema.projects);
    const indexNames = config.indexes.map((i) => i.config.name);
    expect(indexNames).toContain("projects_workspace_slug_unique");
  });

  it("oauth_accounts has provider-account unique index", () => {
    const config = getTableConfig(schema.oauthAccounts);
    const indexNames = config.indexes.map((i) => i.config.name);
    expect(indexNames).toContain("oauth_accounts_provider_account_unique");
  });
});
