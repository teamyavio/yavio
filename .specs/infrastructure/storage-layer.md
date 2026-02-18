# 5. Storage Layer

The platform uses two databases: **ClickHouse** for high-volume analytics event storage and **PostgreSQL** for application data (users, workspaces, projects, API keys).

## 5.1 ClickHouse (Analytics Events)

All events from all projects land in ClickHouse. The schema is optimized for time-series analytics queries with workspace and project scoping.

### 5.1.1 Configuration

| Setting | Value | Rationale |
|---------|-------|-----------|
| Engine | ReplacingMergeTree | Optimal for append-heavy analytics workloads with at-least-once dedup on `event_id`. |
| Partitioning | By month (`toYYYYMM(timestamp)`) | Efficient range queries and TTL-based retention |
| Order key | `(workspace_id, project_id, event_type, timestamp, event_id)` | Primary query patterns: workspace-scoped, project-scoped, type-filtered, time-sorted. `event_id` for dedup. |
| TTL | Community: 90 days. Pro: configurable (default unlimited) | Automatic cleanup for free tiers. Prevents unbounded growth. |
| Compression | LZ4 (default) | Best compression-to-speed ratio for analytics data |

### 5.1.2 Events Table

```sql
CREATE TABLE events (
  -- Identity
  event_id        String,               -- UUID, unique per event (dedup key)
  workspace_id    String,
  project_id      String,
  trace_id        String,
  session_id      String,               -- analytics session: "ses_" prefix, derived from MCP initialize handshake. Shared by server and widget events.

  -- Event classification
  event_type      LowCardinality(String),   -- tool_call | step | track | conversion | identify | connection | widget_* | etc.
  event_name      Nullable(String),         -- tool name, step name, or custom event name
  timestamp       DateTime64(3, 'UTC'),     -- millisecond precision
  platform        LowCardinality(Nullable(String)),  -- chatgpt | claude | cursor | vscode | unknown
  source          LowCardinality(String),   -- server | widget

  -- User identification (set by .identify())
  user_id         Nullable(String),         -- developer-provided user ID
  user_traits     JSON,                     -- user traits object (PII-stripped)

  -- Tool call fields
  latency_ms      Nullable(Float64),
  status          LowCardinality(Nullable(String)),   -- success | error
  error_category  LowCardinality(Nullable(String)),   -- auth | validation | timeout | rate_limit | server | unknown
  error_message   Nullable(String),                   -- sanitized, PII-stripped
  is_retry        UInt8 DEFAULT 0,

  -- Input/Output capture (PII-stripped)
  input_keys      JSON,                     -- array of parameter key names
  input_types     JSON,                     -- object: key → type
  intent_signals  JSON,                     -- array: ["intent:budget", ...]

  -- Token estimation
  tokens_in       Nullable(UInt32),
  tokens_out      Nullable(UInt32),

  -- Conversion fields
  conversion_value    Nullable(Float64),
  conversion_currency LowCardinality(Nullable(String)),

  -- Widget fields
  viewport_width   Nullable(UInt16),
  viewport_height  Nullable(UInt16),

  -- Geographic
  country_code     LowCardinality(Nullable(String)),  -- ISO 3166-1 alpha-2

  -- Connection/protocol fields
  protocol_version  Nullable(String),
  client_name       Nullable(String),
  client_version    Nullable(String),
  connection_duration_ms Nullable(Float64),

  -- Widget interaction fields
  scroll_depth_pct    Nullable(Float64),
  click_count         Nullable(UInt32),
  visible_duration_ms Nullable(Float64),
  field_name          Nullable(String),
  nav_from            Nullable(String),
  nav_to              Nullable(String),
  device_touch        Nullable(UInt8),
  device_pixel_ratio  Nullable(Float32),
  connection_type     LowCardinality(Nullable(String)),
  load_time_ms        Nullable(Float64),

  -- Funnel step ordering
  step_sequence     Nullable(UInt32),       -- auto-incrementing counter per trace (0, 1, 2, ...) for step events

  -- Metadata (JSON, PII-stripped)
  metadata          JSON,                   -- custom properties object

  -- Ingestion metadata
  sdk_version       Nullable(String),
  ingested_at       DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (workspace_id, project_id, event_type, timestamp, event_id)
TTL timestamp + INTERVAL 90 DAY  -- default for self-hosted; Cloud overrides via ALTER TABLE at startup
SETTINGS index_granularity = 8192;
```

### 5.1.3 ClickHouse Indexes

```sql
-- Secondary indexes for common query patterns
ALTER TABLE events ADD INDEX idx_trace_id trace_id TYPE bloom_filter GRANULARITY 4;
ALTER TABLE events ADD INDEX idx_session_id session_id TYPE bloom_filter GRANULARITY 4;
ALTER TABLE events ADD INDEX idx_event_name event_name TYPE bloom_filter GRANULARITY 4;
ALTER TABLE events ADD INDEX idx_platform platform TYPE set(10) GRANULARITY 4;
ALTER TABLE events ADD INDEX idx_status status TYPE set(5) GRANULARITY 4;
ALTER TABLE events ADD INDEX idx_user_id user_id TYPE bloom_filter GRANULARITY 4;
```

### 5.1.4 Sessions Materialized View

Aggregated session summaries, auto-computed by ClickHouse's materialized view engine.

```sql
CREATE MATERIALIZED VIEW sessions_mv
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(session_start)
ORDER BY (workspace_id, project_id, session_id)
AS SELECT
  workspace_id,
  project_id,
  session_id,
  anyLastIf(user_id, user_id IS NOT NULL) AS user_id,
  min(timestamp) AS session_start,
  max(timestamp) AS session_end,
  anyLast(platform) AS platform,
  anyLast(country_code) AS country_code,
  uniqExactIf(event_name, event_type = 'tool_call') AS tool_count,
  countIf(event_type = 'tool_call') AS invocation_count,
  count() AS event_count,
  countIf(event_type = 'conversion') AS conversion_count,
  sumIf(conversion_value, event_type = 'conversion') AS total_revenue,
  anyLastIf(conversion_currency, event_type = 'conversion') AS revenue_currency,
  dateDiff('millisecond', min(timestamp), max(timestamp)) AS duration_ms,
  maxIf(1, event_type = 'widget_render') AS has_widget,
  dateDiff('millisecond',
    minIf(timestamp, event_type = 'widget_render'),
    minIf(timestamp, event_type = 'widget_click')
  ) AS ttfi_ms
FROM events
GROUP BY workspace_id, project_id, session_id;
```

### 5.1.5 Users Materialized View

Aggregated user-level summaries, auto-computed by ClickHouse. Enables retention analysis, DAU/WAU/MAU, per-user funnels, and cohort breakdowns. Only populated for sessions where `.identify()` was called.

```sql
CREATE MATERIALIZED VIEW users_mv
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(first_seen)
ORDER BY (workspace_id, project_id, user_id)
AS SELECT
  workspace_id,
  project_id,
  user_id,
  min(timestamp) AS first_seen,
  max(timestamp) AS last_seen,
  count() AS total_events,
  uniq(session_id) AS total_sessions,
  countIf(event_type = 'tool_call') AS total_tool_calls,
  countIf(event_type = 'conversion') AS total_conversions,
  sumIf(conversion_value, event_type = 'conversion') AS total_revenue,
  anyLastIf(conversion_currency, event_type = 'conversion') AS revenue_currency,
  anyLast(user_traits) AS latest_traits,
  anyLast(platform) AS last_platform,
  anyLast(country_code) AS last_country
FROM events
WHERE user_id IS NOT NULL
GROUP BY workspace_id, project_id, user_id;
```

### 5.1.6 Tool Registry Table

```sql
CREATE TABLE tool_registry (
  project_id    String,
  tool_name     String,
  description   Nullable(String),
  input_schema  JSON,                     -- JSON Schema of tool parameters
  registered_at DateTime64(3, 'UTC'),
  updated_at    DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (project_id, tool_name);
```

### 5.1.8 Row Policies (Tenant Isolation)

ClickHouse does not support session-variable-based RLS like PostgreSQL. Instead, tenant isolation uses **custom settings + row policies** — a fail-closed pattern where queries that omit the tenant context error out rather than returning all data.

#### Users & Roles

Two ClickHouse users separate the read and write paths:

| User | Used By | Access | Row Policies |
|------|---------|--------|-------------|
| `yavio_ingest` | Ingestion API (`yavio-ingest`) | INSERT on `events` and `tool_registry` only | None — write path is pre-validated by API key → workspace/project lookup |
| `yavio_dashboard` | Dashboard (`yavio-dashboard`) | SELECT on all tables | Enforced — every SELECT must provide tenant context |

```sql
CREATE USER yavio_ingest IDENTIFIED BY '${CLICKHOUSE_INGEST_PASSWORD}';
CREATE USER yavio_dashboard IDENTIFIED BY '${CLICKHOUSE_DASHBOARD_PASSWORD}';

GRANT INSERT ON events TO yavio_ingest;
GRANT INSERT ON tool_registry TO yavio_ingest;
GRANT SELECT ON *.* TO yavio_dashboard;
```

#### Custom Settings

The dashboard passes tenant context via ClickHouse custom settings on every query. These settings are not part of the SQL string — they travel as connection-level metadata, eliminating SQL injection risk.

```sql
SET CUSTOM_SQL_workspace_id = '';
SET CUSTOM_SQL_project_id = '';
```

> **Fail-closed behavior:** If the dashboard omits these settings, the query fails with an `Unknown setting` error. This is the key safety property — a missing `WHERE` clause causes a hard failure instead of a silent data leak.

#### Row Policies

One policy per table, scoped by the column available in that table. Tables with `workspace_id` use it as the primary isolation boundary. Tables with only `project_id` use project-level scoping.

```sql
-- ── Events table (workspace-scoped) ──────────────────────────────
CREATE ROW POLICY workspace_isolation ON events
  USING workspace_id = getSetting('SQL_workspace_id')
  TO yavio_dashboard;

-- ── Materialized views (workspace-scoped) ────────────────────────
CREATE ROW POLICY workspace_isolation ON sessions_mv
  USING workspace_id = getSetting('SQL_workspace_id')
  TO yavio_dashboard;

CREATE ROW POLICY workspace_isolation ON users_mv
  USING workspace_id = getSetting('SQL_workspace_id')
  TO yavio_dashboard;

-- ── Tool registry (project-scoped) ──────────────────────────────
CREATE ROW POLICY project_isolation ON tool_registry
  USING project_id = getSetting('SQL_project_id')
  TO yavio_dashboard;

-- Row policies for: clustering_results, llm_insights, anomaly_events, benchmark_snapshots
```

#### Dashboard Query Layer Integration

The `@clickhouse/client` instance used by the dashboard must inject both settings on every query. This is handled by a wrapper in `lib/clickhouse/`:

```typescript
// lib/clickhouse/query.ts
export async function queryClickHouse<T>(
  workspaceId: string,
  projectId: string,
  query: string,
  params?: Record<string, unknown>,
): Promise<T[]> {
  return client.query({
    query,
    query_params: params,
    clickhouse_settings: {
      SQL_workspace_id: workspaceId,
      SQL_project_id: projectId,
    },
  }).then(r => r.json());
}
```

All dashboard Server Components and analytics API routes call `queryClickHouse()` instead of the raw client. The wrapper is the single enforcement point — individual queries do not need (and should not add) their own `WHERE workspace_id = ...` clauses, though they may still filter by `project_id` for project-scoped views.

> **Intelligence service:** The intelligence service (`yavio-intelligence`) uses a separate ClickHouse user (`yavio_intelligence`) with scoped INSERT and SELECT grants. Row policies are enforced on SELECT — the service must pass `SQL_project_id` on every query. For cross-project benchmarking, a dedicated aggregation function computes anonymized percentiles without exposing raw tenant data.

## 5.2 PostgreSQL (Application Data)

PostgreSQL stores all non-analytics data: user accounts, workspaces, projects, API keys, team memberships, and invitations.

### 5.2.1 Users

```sql
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT UNIQUE NOT NULL,
  name            TEXT,
  password_hash   TEXT,                    -- Argon2id hash (NULL for OAuth-only users). Minimum params: memory=65536 KiB, iterations=3, parallelism=4.
  avatar_url      TEXT,
  email_verified  BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
```

### 5.2.2 OAuth Accounts

```sql
CREATE TABLE oauth_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,           -- github | google
  provider_account_id TEXT NOT NULL,
  access_token    TEXT,                    -- encrypted at rest (AES-256-GCM, key from ENCRYPTION_KEY env var)
  refresh_token   TEXT,                    -- encrypted at rest (AES-256-GCM, key from ENCRYPTION_KEY env var)
  expires_at      TIMESTAMPTZ,
  UNIQUE(provider, provider_account_id)
);

-- SECURITY: access_token and refresh_token are encrypted at the application layer
-- before storage using AES-256-GCM with the ENCRYPTION_KEY environment variable.
-- The application decrypts tokens only when needed for OAuth refresh flows.
-- If the database is compromised, encrypted tokens are unusable without the key.
```

### 5.2.3 Sessions (Auth)

> **Terminology note:** This table stores **dashboard authentication sessions** (NextAuth.js login state). It is unrelated to **analytics sessions** (`session_id` in ClickHouse), which represent MCP connections. See [server-sdk.md Section 3.7](../sdk/server-sdk.md#37-session-lifecycle) for analytics session semantics.

```sql
CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token           TEXT UNIQUE NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_sessions_token ON sessions(token);
```

### 5.2.4 Workspaces

```sql
CREATE TABLE workspaces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,    -- URL-friendly identifier
  owner_id        UUID NOT NULL REFERENCES users(id),
  plan            TEXT DEFAULT 'community', -- community | cloud_free | cloud_pro | enterprise
  stripe_customer_id TEXT,                  -- Stripe customer ID (Cloud only, NULL for self-hosted)
  spending_cap    NUMERIC(10,2),            -- monthly spending cap in USD (NULL = unlimited)
  billing_status  TEXT DEFAULT 'active',    -- active | past_due | paused | cancelled
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_workspaces_slug ON workspaces(slug);
CREATE UNIQUE INDEX idx_workspaces_stripe_customer ON workspaces(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
```

### 5.2.5 Workspace Members

```sql
CREATE TABLE workspace_members (
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'member', -- admin | member | viewer
  joined_at       TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
```

### 5.2.6 Invitations

```sql
CREATE TABLE invitations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member',
  invited_by      UUID NOT NULL REFERENCES users(id),
  token           TEXT UNIQUE NOT NULL,    -- invite link token
  accepted_at     TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_invitations_token ON invitations(token);
CREATE INDEX idx_invitations_email ON invitations(email);
```

### 5.2.7 Projects

```sql
CREATE TABLE projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,           -- URL-friendly, unique within workspace
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workspace_id, slug)
);
```

### 5.2.8 API Keys

```sql
CREATE TABLE api_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, -- denormalized for fast lookup
  key_hash        TEXT NOT NULL,           -- HMAC-SHA256(API_KEY_HASH_SECRET, full_key). Server-side secret prevents precomputation attacks.
  key_prefix      TEXT NOT NULL,           -- First 8 chars for identification (yav_proj_)
  name            TEXT DEFAULT 'Default',  -- Human-readable label
  last_used_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now(),
  revoked_at      TIMESTAMPTZ              -- NULL = active, set = revoked
);

CREATE INDEX idx_api_keys_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;
CREATE INDEX idx_api_keys_project ON api_keys(project_id);
CREATE INDEX idx_api_keys_workspace ON api_keys(workspace_id);
```

### 5.2.9 Verification Tokens

Stores time-limited tokens for email verification and password reset flows. Accessed by `yavio_service` role only (pre-authentication flows).

```sql
CREATE TABLE verification_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL,            -- HMAC-SHA256 hash of the token (same scheme as API keys)
  type            TEXT NOT NULL,            -- email_verification | password_reset
  expires_at      TIMESTAMPTZ NOT NULL,     -- email_verification: 24 hours, password_reset: 1 hour
  used_at         TIMESTAMPTZ,             -- set on use, prevents reuse
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_verification_tokens_hash ON verification_tokens(token_hash) WHERE used_at IS NULL;
CREATE INDEX idx_verification_tokens_user ON verification_tokens(user_id);
```

### 5.2.10 Login Attempts

Tracks failed login attempts for brute-force detection and account lockout (see [dashboard architecture §7.10.3](../dashboard/architecture.md)). Accessed by `yavio_service` role only. Rows older than 24 hours are cleaned up daily.

```sql
CREATE TABLE login_attempts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL,            -- login email (may not correspond to existing user)
  ip_address      INET NOT NULL,
  attempted_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_login_attempts_email ON login_attempts(email, attempted_at);
CREATE INDEX idx_login_attempts_cleanup ON login_attempts(attempted_at);
```

### 5.2.11 Stripe Webhook Events

Ensures idempotent processing of Stripe webhook deliveries (see [billing.md](../pricing/billing.md)). Cloud only. Accessed by `yavio_service` role only. Records older than 30 days are cleaned up by a scheduled job.

```sql
CREATE TABLE stripe_webhook_events (
  event_id        TEXT PRIMARY KEY,         -- Stripe event ID (evt_*)
  event_type      TEXT NOT NULL,            -- Stripe event type (e.g., invoice.paid)
  processed_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_stripe_webhook_cleanup ON stripe_webhook_events(processed_at);
```

### 5.2.12 Additional Indexes

```sql
-- Find all workspaces a user belongs to
CREATE INDEX idx_workspace_members_user ON workspace_members(user_id);

-- List projects within a workspace
CREATE INDEX idx_projects_workspace ON projects(workspace_id);

-- Find all OAuth accounts for a user
CREATE INDEX idx_oauth_accounts_user ON oauth_accounts(user_id);
```

> **API Key Format:** Keys follow the pattern `yav_proj_<32 random chars>`. Only the HMAC-SHA256 hash is stored (`HMAC(SHA256, API_KEY_HASH_SECRET, full_key)`). The `API_KEY_HASH_SECRET` is a server-side environment variable — it prevents precomputation and rainbow table attacks even if the database is compromised. The full key is shown once at creation time and never again. The `yav_proj_` prefix allows key scanning tools to identify leaked keys.

### 5.2.13 Row-Level Security (Tenant Isolation)

PostgreSQL RLS provides defense-in-depth for tenant data isolation. Even if a bug in an API route omits a workspace check, the database itself prevents cross-tenant data access.

#### Database Roles

Two PostgreSQL roles separate privileged and unprivileged access:

| Role | Used By | RLS | Purpose |
|------|---------|-----|---------|
| `yavio_service` | Migrations, background jobs (session cleanup, invitation expiry, API key pruning), NextAuth.js internals, login attempt tracking, token verification, Stripe webhook processing | Bypassed (table owner) | Schema management, housekeeping, auth session management |
| `yavio_app` | Dashboard API routes, Server Components | Enforced | All user-facing database access |

```sql
-- Service role owns tables (bypasses RLS by default)
CREATE ROLE yavio_service LOGIN PASSWORD '${POSTGRES_SERVICE_PASSWORD}';

-- App role has RLS enforced
CREATE ROLE yavio_app LOGIN PASSWORD '${POSTGRES_APP_PASSWORD}';
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO yavio_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO yavio_app;
```

#### Session Variable

The app role identifies the current user via a session-local variable set at the start of each transaction:

```sql
SET LOCAL app.current_user_id = '<user-uuid>';
```

This variable is scoped to the current transaction and automatically cleared on commit/rollback.

#### Policies

RLS is enabled on all application tables. Each table has policies matching its access pattern.

**User-scoped tables** — user can only access their own rows:

```sql
-- Users: own row only
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_self ON users
  USING (id = current_setting('app.current_user_id')::uuid);

-- OAuth accounts: own accounts only
ALTER TABLE oauth_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY oauth_self ON oauth_accounts
  USING (user_id = current_setting('app.current_user_id')::uuid);

-- Sessions: own sessions only
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY session_self ON sessions
  USING (user_id = current_setting('app.current_user_id')::uuid);
```

**Workspace-scoped tables** — user can access rows in workspaces they belong to:

```sql
-- Workspaces: must be a member
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_member ON workspaces
  USING (id IN (
    SELECT workspace_id FROM workspace_members
    WHERE user_id = current_setting('app.current_user_id')::uuid
  ));

-- Workspace members: can see co-members
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY member_visibility ON workspace_members
  USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members
    WHERE user_id = current_setting('app.current_user_id')::uuid
  ));

-- Invitations: visible to members of the workspace
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY invitation_visibility ON invitations
  USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members
    WHERE user_id = current_setting('app.current_user_id')::uuid
  ));

-- Projects: visible to workspace members
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_visibility ON projects
  USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members
    WHERE user_id = current_setting('app.current_user_id')::uuid
  ));

-- API keys: visible to workspace members
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY key_visibility ON api_keys
  USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members
    WHERE user_id = current_setting('app.current_user_id')::uuid
  ));
```

> **Write restrictions** are not enforced via RLS policies. Role-based write permissions (e.g., only Admins can create projects) remain in application code, where the logic depends on the user's `role` within a workspace — not just membership. RLS ensures **visibility isolation**; the application layer handles **permission granularity**.

#### Drizzle ORM Integration

All user-facing database access goes through a `withRLS` transaction wrapper that sets the session variable before executing queries:

```typescript
// lib/db/rls.ts
import { db } from './client';  // Drizzle client connected as yavio_app
import { sql } from 'drizzle-orm';

export async function withRLS<T>(
  userId: string,
  fn: (tx: typeof db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
    return fn(tx);
  });
}
```

Dashboard API routes use this wrapper:

```typescript
// Example: GET /api/workspaces
export async function GET(req: Request) {
  const session = await getServerSession();
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const workspaces = await withRLS(session.user.id, (tx) =>
    tx.select().from(workspacesTable)
    // No WHERE clause needed — RLS filters automatically
  );

  return Response.json(workspaces);
}
```

> **Fail-closed behavior:** If `withRLS` is not used and `app.current_user_id` is not set, `current_setting()` throws an error, causing the query to fail rather than returning unscoped data. This can be made explicit with `current_setting('app.current_user_id', true)` (returns NULL on missing) paired with a `USING (... IS NOT NULL AND ...)` check in the policy, but the default throw behavior is preferred as it is strictly fail-closed.

## 5.3 Data Retention

### 5.3.1 ClickHouse TTL

Data retention is managed by ClickHouse's built-in TTL mechanism. TTL is applied **globally per deployment** (not per workspace) — all workspaces within a deployment share the same retention window. This follows the same model as PostHog and avoids the complexity of per-tenant TTL in a shared table.

| Deployment | Default Retention | Configurable |
|------------|------------------|--------------|
| Self-hosted (Community) | 90 days | Yes, via env var `YAVIO_RETENTION_DAYS` |
| Cloud | 1 year | No |

**Mechanism:** On startup, the API server reads the configured retention period and runs `ALTER TABLE events MODIFY TTL timestamp + INTERVAL <N> DAY` (and the same for materialized view target tables). For self-hosted, `<N>` comes from `YAVIO_RETENTION_DAYS` (default: 90). For Cloud, it is hardcoded to 365.

**What happens when data expires:** ClickHouse automatically drops entire monthly partitions once all rows in the partition exceed the TTL threshold. Data is **permanently deleted** — there is no archival, downsampling, or rollup before deletion. The month-based partitioning (`toYYYYMM(timestamp)`) makes this efficient: whole partitions are dropped at once, not row-by-row.

**Enterprise (future):** If per-workspace custom retention is needed, this will be implemented as a background cleanup job that deletes rows by `workspace_id` + age, running alongside the global TTL (which acts as a hard ceiling). See appendix for roadmap.

### 5.3.2 PostgreSQL Cleanup

- Expired sessions: cleaned up by a background job every hour
- Expired invitations: cleaned up daily
- Revoked API keys: retained for audit trail, cleaned up after 1 year
- Login attempts: rows older than 24 hours cleaned up daily
- Used/expired verification tokens: cleaned up daily
- Stripe webhook events: records older than 30 days cleaned up by scheduled job

## 5.4 Schema Evolution

The event schema will change over time as the platform gains new capabilities. This section defines the rules for evolving the schema without breaking existing SDK deployments or corrupting stored data.

### 5.4.1 Versioning Contract

The platform uses **semantic versioning** across three independently versioned surfaces:

| Surface | Example | Versioned In |
|---------|---------|--------------|
| SDK package | `@yavio/sdk@1.2.0` | `package.json` version field |
| Event schema | `1.2` (MAJOR.MINOR) | `sdk_version` field on every event |
| Ingestion API | `/v1/events` | URL path prefix |

**SDK version** follows npm semver. The **event schema version** is derived from the SDK's MAJOR.MINOR — patch releases never change the event shape. The **ingestion API version** is in the URL path and only increments on breaking wire-protocol changes.

**Compatibility promise:** The ingestion API at `/v1/events` accepts events from any SDK version within the same MAJOR. An SDK at `1.0.0` and an SDK at `1.9.0` both send to `/v1/events` and both are fully supported. A MAJOR bump (e.g., `2.0.0`) may require `/v2/events`, with the previous endpoint supported for a documented deprecation window.

### 5.4.2 Change Classification

Every schema change falls into one of three categories:

| Category | Rule | Example | SDK Bump |
|----------|------|---------|----------|
| **Additive** | New optional field, new event type, new `metadata` key | Add `scroll_direction` column, add `widget_long_press` event type | MINOR |
| **Behavioral** | Changed semantics of an existing field without changing its type or name | `is_retry` detection logic refined | MINOR (document in changelog) |
| **Breaking** | Removed field, renamed field, changed field type, changed ID format | Remove `input_keys`, rename `latency_ms` → `duration_ms`, change `tokens_in` from UInt32 to Float64 | MAJOR |

**Goal:** All changes in v1.x are additive or behavioral. Breaking changes are deferred to a major version bump.

### 5.4.3 Adding a Field

Adding a new column to the `events` table is the most common schema change. The procedure:

1. **ClickHouse:** `ALTER TABLE events ADD COLUMN <name> <Type> DEFAULT <default>`. New columns must be `Nullable` or have an explicit `DEFAULT`. This is a non-blocking, zero-downtime operation in ClickHouse.
2. **Materialized views:** If the new field should appear in `sessions_mv` or `users_mv`, recreate the view (ClickHouse materialized views are append-only — existing rows are not backfilled). New view only applies to events ingested after the migration.
3. **Ingestion API:** Accept the new field. Older SDKs that do not send it produce `NULL` (or the default). No validation error.
4. **SDK:** New SDK version populates the field. Released as a MINOR bump.
5. **Dashboard:** New queries and visualizations for the field. Gracefully handle `NULL` for historical data that predates the field.

**Self-hosted migration:** The startup migration runner detects missing columns and applies `ALTER TABLE ADD COLUMN` idempotently. Self-hosted operators upgrading the Docker images get schema changes automatically on next restart.

### 5.4.4 Adding an Event Type

New event types (e.g., `widget_long_press`) follow the same additive pattern:

1. **No schema migration required.** The `event_type` column is `LowCardinality(String)` — any new string value is accepted without a DDL change.
2. **SDK:** New SDK version emits the event. Released as a MINOR bump.
3. **Ingestion API:** Passes through. The ingestion API validates event structure, not event type values. Unknown event types with valid structure are accepted.
4. **Dashboard:** New views or filters for the event type. Unknown event types appear in the raw event feed but are excluded from typed views until the dashboard is updated.

### 5.4.5 Deprecating a Field

Fields are never removed within a MAJOR version. Instead, they go through a deprecation lifecycle:

| Phase | Duration | What Happens |
|-------|----------|--------------|
| **Active** | — | Field is populated by the current SDK and used by the dashboard |
| **Deprecated** | Minimum 6 months or 2 MINOR releases, whichever is longer | SDK still populates the field. Dashboard stops relying on it for new features. Changelog and docs mark it as deprecated. |
| **Removed** | Next MAJOR version | SDK stops sending the field. Ingestion API silently ignores it from older SDKs. ClickHouse column retained for historical queries but no longer written to. |
| **Dropped** | After data retention window expires | Column dropped from ClickHouse via `ALTER TABLE DROP COLUMN` once all partitions containing the field have aged out. |

**Telemetry-informed timing:** The anonymous telemetry system (see [telemetry.md](../telemetry.md)) reports `sdk_version` distribution across all deployments. A deprecated field is not moved to "Removed" until telemetry confirms <5% of active SDKs still send it, or the minimum deprecation window has elapsed — whichever comes later.

### 5.4.6 Renaming a Field

Renames are breaking changes and are avoided within a MAJOR version. If a rename is essential:

1. **Add the new field** as an additive change (5.4.3). New SDK versions populate both old and new fields during a transition window.
2. **Deprecate the old field** (5.4.5).
3. **Ingestion API aliasing:** During the transition, the ingestion API copies `old_field` → `new_field` for events from older SDKs that only send the old name. This ensures the dashboard can query exclusively on the new field name.
4. **Remove the old field** in the next MAJOR version.

### 5.4.7 Changing a Field Type

Type changes are breaking. The only safe in-place type changes in ClickHouse are widening conversions (e.g., `UInt16` → `UInt32`, `Float32` → `Float64`). These are treated as additive changes and applied directly.

Narrowing conversions or type-class changes (e.g., `String` → `UInt32`) follow the rename procedure: add a new column with the target type, populate both during transition, deprecate the old column.

### 5.4.8 Ingestion API Tolerance

The ingestion API is **permissive on input, strict on output:**

| Scenario | Behavior |
|----------|----------|
| SDK sends an unknown field not in the schema | Field is silently dropped. No error returned. This allows newer SDKs to work with older ingestion API versions during rolling upgrades. |
| SDK omits an optional field | `NULL` or `DEFAULT` value written to ClickHouse. No error. |
| SDK sends wrong type for a known field | Event rejected with per-event error in `207 Multi-Status` response. SDK retries are pointless — event is dropped after first rejection. |
| SDK sends an unknown `event_type` with valid structure | Accepted and stored. Dashboard shows it in the raw event feed. |
| SDK sends a deprecated field | Accepted and stored normally. No warning returned (to avoid noise in SDK logs). |

This tolerance policy ensures that **mixed SDK versions in production do not cause data loss.** A deployment running SDK `1.3.0` alongside SDK `1.1.0` works without coordination. The ingestion API is the compatibility bridge.

### 5.4.9 SDK Backward Compatibility

The SDK maintains backward compatibility within a MAJOR version:

| Guarantee | Scope |
|-----------|-------|
| No removed public API methods | `withYavio()`, `useYavio()`, `.identify()`, `.step()`, `.track()`, `.conversion()` signatures are stable within v1.x |
| No removed config options | Options passed to `withYavio()` are never removed, only deprecated (replaced by no-ops with a console warning) |
| TypeScript types are additive | New optional fields on config or event types. No removed or renamed type properties within v1.x. |
| Default behavior preserved | New auto-capture features default to `true` (opt-out via `capture` config) but never change the behavior of existing capture flags |

### 5.4.10 Dashboard Backward Compatibility

The dashboard queries ClickHouse and must handle schema differences across time:

- **Missing columns:** Queries use `ifNull(column, default)` or `COALESCE` for fields that may not exist in older partitions. The dashboard never assumes a column has been populated for all time.
- **New event types:** Event type filter dropdowns are populated dynamically from `SELECT DISTINCT event_type`. New types appear automatically.
- **Deprecated fields:** Dashboard views migrate to replacement fields immediately but fall back to deprecated fields for historical date ranges where only the old field has data.

### 5.4.11 Migration Runner

Schema migrations are applied automatically on service startup:

| Component | Migration Mechanism |
|-----------|-------------------|
| ClickHouse | Startup script in `yavio-ingest` checks a `schema_migrations` table and applies pending `.sql` files in order. Each migration is idempotent (uses `IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`). |
| PostgreSQL | Drizzle ORM migrations (`drizzle-kit push` or `drizzle-kit migrate`), run by the dashboard on startup. |

**Self-hosted upgrade path:** Pull new Docker images → restart services → migrations run automatically. No manual SQL required. Migrations are forward-only — rollback requires restoring from backup.

**Cloud:** Migrations are applied during deploy. Blue-green deployment ensures zero downtime: the new version's migrations run before traffic is shifted.

### 5.4.12 Version Support Policy

| Policy | Rule |
|--------|------|
| **Supported SDK versions** | Current MAJOR and previous MAJOR. When SDK v2.0.0 ships, v1.x remains supported at `/v1/events` for 12 months. |
| **Ingestion API versions** | Previous API version remains operational for 12 months after the new version launches. Requests to the old version return a `Deprecation` response header with the sunset date. |
| **Self-hosted upgrades** | Supported upgrade path: any version within the current MAJOR to latest. Skipping a MAJOR version (e.g., v1 → v3) is not supported — upgrade to v2 first. |
| **Communication** | Breaking changes announced in: GitHub release notes, npm deprecation warnings, dashboard banner (for self-hosted operators on outdated versions), and the documentation changelog. |
