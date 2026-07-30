import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  inet,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// =============================================================================
// 1. Users
// =============================================================================

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").unique().notNull(),
  name: text("name"),
  passwordHash: text("password_hash"),
  avatarUrl: text("avatar_url"),
  emailVerified: boolean("email_verified").default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// =============================================================================
// 2. OAuth Accounts
// =============================================================================

export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("oauth_accounts_provider_account_unique").on(
      table.provider,
      table.providerAccountId,
    ),
    index("idx_oauth_accounts_user").on(table.userId),
  ],
);

// =============================================================================
// 3. Sessions (Dashboard Auth)
// =============================================================================

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").unique().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_sessions_token").on(table.token)],
);

// =============================================================================
// 4. Workspaces
// =============================================================================

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").unique().notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    plan: text("plan").default("community"),
    stripeCustomerId: text("stripe_customer_id"),
    spendingCap: numeric("spending_cap", { precision: 10, scale: 2 }),
    billingStatus: text("billing_status").default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_workspaces_slug").on(table.slug),
    uniqueIndex("idx_workspaces_stripe_customer")
      .on(table.stripeCustomerId)
      .where(sql`stripe_customer_id IS NOT NULL`),
  ],
);

// =============================================================================
// 5. Workspace Members
// =============================================================================

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index("idx_workspace_members_user").on(table.userId),
  ],
);

// =============================================================================
// 6. Invitations
// =============================================================================

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id),
    token: text("token").unique().notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_invitations_token").on(table.token),
    index("idx_invitations_email").on(table.email),
  ],
);

// =============================================================================
// 7. Projects
// =============================================================================

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("projects_workspace_slug_unique").on(table.workspaceId, table.slug),
    index("idx_projects_workspace").on(table.workspaceId),
  ],
);

// =============================================================================
// 8. API Keys
// =============================================================================

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    name: text("name").default("Default"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_api_keys_hash").on(table.keyHash).where(sql`revoked_at IS NULL`),
    index("idx_api_keys_project").on(table.projectId),
    index("idx_api_keys_workspace").on(table.workspaceId),
  ],
);

// =============================================================================
// 8b. OAuth Authorization Server (MCP connector clients)
// =============================================================================
// Not related to oauth_accounts (next-auth sign-in). These tables back the
// dashboard's own OAuth 2.1 authorization server that MCP clients (Claude,
// ChatGPT) authorize against. Tokens are opaque and stored HMAC-SHA256 hashed,
// same pattern as api_keys.key_hash.

export const oauthClients = pgTable("oauth_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  // CIMD clients: the https:// metadata-document URL itself.
  // DCR clients: a generated opaque id.
  clientId: text("client_id").unique().notNull(),
  registrationType: text("registration_type").notNull(), // 'cimd' | 'dcr'
  clientName: text("client_name"),
  clientUri: text("client_uri"),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull().default("none"),
  applicationType: text("application_type"),
  // CIMD only: when the metadata document was last re-fetched.
  metadataRefreshedAt: timestamp("metadata_refreshed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const oauthCodes = pgTable(
  "oauth_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    codeHash: text("code_hash").unique().notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    scope: text("scope").notNull(),
    codeChallenge: text("code_challenge").notNull(), // PKCE S256, base64url
    resource: text("resource"), // RFC 8707 audience requested at /oauth/authorize
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_oauth_codes_expiry").on(table.expiresAt)],
);

export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Grant family: constant across refresh rotations. Revoking the family
    // invalidates every token that ever belonged to this authorization.
    grantId: uuid("grant_id").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    audience: text("audience").notNull(), // canonical MCP URL (RFC 8707)
    accessTokenHash: text("access_token_hash").unique().notNull(),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }).notNull(),
    refreshTokenHash: text("refresh_token_hash").unique(),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    // Set when a newer rotation superseded this row. A rotated-out refresh
    // token arriving within the grace window is a benign client race; after
    // the window it is treated as replay and revokes the whole family.
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_oauth_tokens_grant").on(table.grantId)],
);

// =============================================================================
// 9. Verification Tokens
// =============================================================================

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    type: text("type").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_verification_tokens_hash").on(table.tokenHash).where(sql`used_at IS NULL`),
    index("idx_verification_tokens_user").on(table.userId),
  ],
);

// =============================================================================
// 10. Login Attempts
// =============================================================================

export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    ipAddress: inet("ip_address").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_login_attempts_email").on(table.email, table.attemptedAt),
    index("idx_login_attempts_cleanup").on(table.attemptedAt),
  ],
);

// =============================================================================
// 11. Stripe Webhook Events
// =============================================================================

export const stripeWebhookEvents = pgTable(
  "stripe_webhook_events",
  {
    eventId: text("event_id").primaryKey(),
    eventType: text("event_type").notNull(),
    processedAt: timestamp("processed_at", {
      withTimezone: true,
    }).defaultNow(),
  },
  (table) => [index("idx_stripe_webhook_cleanup").on(table.processedAt)],
);
