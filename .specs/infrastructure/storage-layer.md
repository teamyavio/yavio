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
| TTL | 13 months from collection, row-wise (`least(timestamp, ingested_at)`) | The identifiable window: a year-over-year comparison plus the current month. See §5.3.1. |
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
  intent_context  LowCardinality(Nullable(String)),   -- required | optional | none: how `context` was advertised; NULL = SDK < 0.4.0 (#73, migration 0019)

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
  region           LowCardinality(Nullable(String)),  -- state/province as the platform names it, not ISO 3166-2; NULL without a valid country_code (#128, migration 0020)

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
  step_sequence     Nullable(UInt32),       -- step events: counter per session PER SDK PROCESS (1, 2, 3, ...), again from 1 on every instance, after an LRU eviction and per widget load; funnels order by timestamp and use it only as a tie-breaker (#145)

  -- Metadata (JSON, PII-stripped)
  metadata          JSON,                   -- custom properties object

  -- Ingestion metadata
  sdk_version       Nullable(String),
  ingested_at       DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (workspace_id, project_id, event_type, timestamp, event_id)
TTL least(toDateTime(timestamp), toDateTime(ingested_at)) + INTERVAL 13 MONTH  -- migration 0013 (#85)
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
-- The live feed tails ingested_at, which is outside the sort key; a minmax
-- index lets its "last 10 s" window prune the granules of its 73 h timestamp bound (#148, migration 0021,
-- with MATERIALIZE INDEX for the existing parts).
ALTER TABLE events ADD INDEX idx_ingested_at ingested_at TYPE minmax GRANULARITY 1;
```

### 5.1.4 Sessions and users (no materialized views)

Sessions are `uniqExact(session_id)` over every event, never a count of `connection` rows: the SDK emits a `connection` event at least once per session **per process** (every instance of a stateless fleet that served the conversation, and again after an LRU eviction), with a random `event_id` and its own timestamp, so the rows never collapse under the ORDER BY above (#142). The #85 statistics job counts connection cells as distinct sessions for the same reason, and `run_query`'s schema doc says so. `tool_discovery` is unaffected: it lands in `tool_registry` (§5.1.6), where `FINAL` keeps the latest report per tool. Sessions and user metrics are computed from `events` at query time (#89). The former `sessions_mv` and `users_mv` were `AggregatingMergeTree` tables with plain-typed columns, so background merges kept an arbitrary row per key: counts collapsed and first/last seen froze. Migration `0018` dropped them, with their row policies and grants. User metrics use one key per person: the event's own `user_id`, else the first `user_id` an `identify` event gave its `session_id`, else the `user_id` the same `subject_id` was identified with, else `subject_id`; never `session_id` itself (§5.3.1).

**Session stitch (#145).** `identify()` stamps `user_id` only on the events of the SDK process that called it, from that call on; on a stateless fleet the other instances' events of the conversation, and every event before the call, carry none. The read side therefore maps each session to the first identified user at query time (`keyedEvents()` in `packages/dashboard/lib/queries/users.ts`, and the same map in the #85 prelude): `argMin(user_id, (timestamp, event_id))` over `identify` rows with a non-empty `user_id` and `session_id` — a primary-key range (`event_type` is in the ORDER BY) — with the subject map's window (unbounded for a named person, the range for windowed counts, #112). First, not last: the SDK's one-user-per-session rule (`YAVIO-1302`) and what one process would have produced; a later identify never re-attributes history — for the unbounded map of the queries that name a person; in a windowed count a session whose first identify falls before the window goes to the first id identified inside it, if there is one — and a stamped `user_id` is never overwritten. The invocation feed and a tool's recent invocations resolve it with one lookup over the page's sessions; the live feed shows the raw `user_id`. Nothing is stored: the identify rows carry the mapping, so tenant erasure, the #93 retention delete and the TTL take it with them, and no materialized view or table needs its own grants, row policies, erasure entry or TTL. Resolving at ingest was rejected: batches from several processes arrive out of order, events written before the identify (and the 13 months already stored) would stay wrong, and it would bake a derived identity into raw rows. Traits are not stitched (only identify rows carry them). A future per-person delete must also remove the pre-identify rows of that person's sessions.

**Funnels (#145).** `step_sequence` restarts at 1 per process (every instance, LRU eviction, widget load), so funnels rank a session's step rows, deduplicated by `event_id`, by `(timestamp, step_sequence, event_id)` with `row_number()`, counting the session's steps from 30 days before the range's start to its end for the rank (review round 1: unbounded, a 7-day funnel read every step the project ever stored — 5.09M of 5M stored step rows plus the range) and only those inside the range for the counts; one session is one attempt. The funnel queries run under `max_execution_time = 25` and `max_memory_usage = 2 GiB`. Within the 30-day look-back a single process gives exactly the old per-`step_sequence` result; a conversation whose earlier steps fall before it is renumbered. Not covered: clock skew between hosts, ingest's +5 min clamp, a wall clock stepping backwards, browser clocks.

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

Three ClickHouse users separate the admin, write, and read paths:

| User | Used By | Access | Row Policies |
|------|---------|--------|-------------|
| `default` | Migrations, user/grant management | Full admin (`access_management=1`) | None |
| `yavio_ingest` | Ingestion API (`yavio-ingest`) | INSERT on `events` and `tool_registry` only | None — write path is pre-validated by API key → workspace/project lookup |
| `yavio_dashboard` | Dashboard (`yavio-dashboard`) | SELECT on all tables | Enforced — every SELECT must provide tenant context |

The `default` user password is set at container startup by `config/clickhouse/init-default-password.sh`, which reads `CLICKHOUSE_ADMIN_PASSWORD` and writes a SHA-256 hash into `/etc/clickhouse-server/users.d/default-password.xml`.

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
  key_prefix      TEXT NOT NULL,           -- First 8 chars for identification (yav_)
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

> **API Key Format:** Keys follow the pattern `yav_<32 random chars>`. Only the HMAC-SHA256 hash is stored (`HMAC(SHA256, API_KEY_HASH_SECRET, full_key)`). The `API_KEY_HASH_SECRET` is a server-side environment variable — it prevents precomputation and rainbow table attacks even if the database is compromised. The full key is shown once at creation time and never again. The `yav_` prefix allows key scanning tools to identify leaked keys.

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

### 5.3.1 ClickHouse: two tiers

Analytics data is kept in two tiers (#85). Customers can quote one sentence about it in their privacy policy (docs: Concepts → Data retention):

> **EN:** "Usage data is deleted automatically 13 months after collection. Only anonymous daily statistics without identifiers are kept beyond that."
> **DE:** „Nutzungsdaten werden 13 Monate nach Erhebung automatisch gelöscht. Dauerhaft bleiben nur anonyme Statistiken auf Tagesbasis ohne Kennungen."

The sentence names no threshold on purpose: how anonymity is ensured is implementation.

| Tier | Tables | Kept | Detail |
|------|--------|------|--------|
| 1 — identifiable | `events` (incl. content columns `input_values`, `output_content`, `intent_signals`, `error_message`, `end_user_agent`, `user_traits`), `tool_registry` | 13 months from collection; per project 2–13 months (#93) | full, hourly |
| 2 — anonymous | `stats_daily`, `stats_users_daily`, `stats_users_periods`, `stats_cohorts` | no TTL | daily, no identifiers, fixed vocabulary |

**Tier 1 TTL.** Migration `0013_events_ttl_13_months.sql` sets it for every deployment and workspace alike:
- **Expression:** `least(toDateTime(timestamp), toDateTime(ingested_at)) + INTERVAL 13 MONTH`.
  - `timestamp` is client-supplied. Taking the earlier of it and the server-set `ingested_at` means a future-dated event cannot escape retention.
  - Ingest also clamps `timestamp` to the last 72 h (#90).
- **Counted per event**, from collection. There is no reset on new activity.
- **Deletion:** rows go **row by row** during merges. Rows already expired at insert are dropped. `ttl_only_drop_parts` stays `0`: with `1`, a monthly partition would only go once all its rows expired, overshooting by up to a month.
- **13 months** allows a year-over-year comparison: 12 months plus the current one.

**Per-project retention (#93).** `projects.retention_months` is 2–13, default 13, with a CHECK constraint.
- **The delete:** the statistics job deletes older raw events daily, in **one** `ALTER TABLE events DELETE` for all affected projects. It counts like the TTL, and runs only after every stats table succeeded in the same run.
- **Why at least 2:** the job recomputes the previous month every day.
- **Retention floor:** for a project at R < 13 months, the statistics of month M read only events collected on or after `start(M + 2 − R)`.
  - No delete reaches that floor before M's last recompute, so a recompute never reads fewer rows than the one before.
  - Look-back measures are cut at the floor: WAU/MAU windows are clamped. Quarter and year users, and cohorts, are left out when they would start before the floor.
- **Prerequisite:** the job runs as `yavio_rollup`. Without `CLICKHOUSE_ROLLUP_PASSWORD` it does not run, and the setting is **not applied**. Ingest logs an error at startup.

**Tier 2: the statistics job** (`packages/ingest/src/stats`, #85 step 3).
- **Schedule:** daily (UTC), under a session-level Postgres advisory lock. Run state lives in `stats_job_runs` and is committed per table as the run goes, so a failure or restart late in a backfill keeps the tables already done.
- **What it computes:** for the previous and current month, plus every month since its last success (backfill on the first run), each stats table is rebuilt from `events FINAL`, deduplicated on `event_id`, via a stage table and `REPLACE PARTITION`. Finished months are frozen and outlive their raw data.
- **`events` for `connection` cells is distinct sessions per day, from the stats runs after the ingest deploy that shipped #142 (date to be filled in at deploy time: YYYY-MM-DD):** `countIf(event_type != 'connection') + uniqExactIf(session_id, event_type = 'connection')`, because the SDK writes one connection row per session per process and those rows never collapse. A `connection` cell is therefore not additive across days (a session seen on two days counts once per day), and since every cell groups by `event_type` the two terms never mix in one cell. **Method break:** the job recomputes only the previous and the current month, so the first run after that deploy recomputes the previous month too, and only months before that keep counting connection *rows*; they are not backfilled. A `connection` figure that spans them mixes the two definitions, and the dashboard's own session counts (`uniqExact(session_id)` over every event type, §5.1.4) are the reference either way.
- **People are keyed with the session stitch (§5.1.4) from the stats runs after the ingest deploy that shipped #145 (date to be filled in at deploy time: YYYY-MM-DD; the same date as #142's above when both ship in one deploy):** the prelude's `session_map` has the dashboard's rule, `base`'s window and the retention floor, and both maps alias their project column (`session_project`, `stitch_project`) — with two LEFT JOINs whose maps both expose `project_id`, ClickHouse 26.8 names the outer column `b.project_id` in `SELECT b.*` and every later reference fails with `UNKNOWN_IDENTIFIER`. **Method break:** as above, the first run after that deploy recomputes the previous month too, and earlier months keep the older key. Their `individuals` are higher where sessions identify (the user plus the unstamped session, instead of one person; 21–29 % on synthetic fleets), and their users can be slightly lower (a day on which a user was seen only through another instance's events). The two must not be compared across that month as a trend.
- **Data start.** A period (`stats_users_periods`) that begins before the earliest stored event is not written, nor is a cohort first seen in that month: the raw data cannot support them, and a frozen month is never corrected. After `0013` the first run sees about 90 days of events, so Q3 2026 and the year 2026 get no distinct-user figure; from Q4 2026 on they do. The retention floor (above) applies the same rule per project.
- **No identifiers.** People are counted (`individuals`, `uniqExact` of the stitched user key, falling back to `session_id`) but never stored. Since #145 an identified session is one individual, its user.
  - **Limit of that fallback:** an app without a user key only has sessions, so one person with several conversations counts several times.
- **Fixed vocabulary.** An `event_name` is kept if it is a registered tool, or one of a project's top 50 names in the month used by at least 5 individuals. Everything else becomes `(other)`. Platform, client name, country, currency and language are normalized.
- **Minimum cell size (planned):** cells with fewer than 5 individuals will be folded into `(other)`. It only matters for months older than 13 months, which exist from mid-2027. The tables keep `individuals` per cell so k can be applied later to months whose raw data is gone.
- **Deletion:** deleting a project, workspace or account erases its rows from both tiers. See §5.3.3.

**Identifiers are personal data.** All three ids are pseudonymous personal data. They are in tier 1 only, never in tier 2:
- `user_id`: set by `identify()`.
- `subject_id`: the platform's stable per-user-per-app id, e.g. ChatGPT's `openai/subject`.
- `session_id`: an unsalted SHA-256 of the platform's session key, truncated.

(Migration `0009`'s comment calls `subject_id` "no personal data". That is wrong; migrations stay unchanged.)

**Self-hosted.** The same tiers and the same 13-month ceiling apply. There is no global retention variable: `YAVIO_RETENTION_DAYS`, described in earlier versions of this spec, was never implemented and is not planned. A shorter retention is set per project (#93).

**User summaries.** `users_mv` and `sessions_mv` are dropped (#89, migration `0018`, with their row policies and grants). User metrics are computed from `events` with the stitched key (§5.1.4: the session map, #145, then the subject map). "First seen" and "new vs returning" therefore mean within the stored window; long-term cohorts come from `stats_cohorts`.

### 5.3.2 PostgreSQL cleanup

The dashboard's housekeeping job (`lib/housekeeping`, #92) runs hourly under an advisory lock:

| Data | Deleted |
|------|---------|
| Login attempts (email, IP) | after 24 h |
| Sessions | once expired |
| Verification tokens | once used or expired |
| Invitations | 1 day after expiry, accepted or not |
| Revoked API keys | 1 year after revocation (audit trail) |
| Stripe webhook ids | after 30 days |
| OAuth codes, tokens, unused client registrations | `pruneExpired()`, also called from the token endpoint |

### 5.3.3 Erasure

Deleting an account, workspace or project removes the Postgres rows and queues an `erasure_requests` row **in the same transaction** (#91).
- **Worker:** the dashboard's erasure worker deletes the tenant's rows from every ClickHouse table, both tiers and `tool_registry` (by the snapshotted project ids). It runs as `yavio_eraser` (`ALTER DELETE` only, no `SELECT`).
- **Retries:** it retries every minute and remembers finished tables. A request pending for more than 24 h is logged as an error.
- **`ERASURE_WORKER=off`** (`lib/erasure/switch.ts`): for a non-production copy that shares a production ClickHouse — a dev dashboard seeded from a production Postgres dump carries the production workspace and project ids, so a deletion there would erase the production tenant's analytics. With the worker off the dashboard boots without `CLICKHOUSE_ERASER_PASSWORD`, the delete routes still remove the Postgres rows and queue the request, and nothing executes it; the mutating ClickHouse client refuses to be created. Any value other than `on`/`off` stops the boot. Never in production: queued requests would never complete.
- **Backups:** erased data stays in earlier backups until they expire, **up to 4 weeks** on Yavio Cloud (14 days on the host plus 14 days of disk snapshots). Docs: Self-Hosting → Backups & Operations.

### 5.3.4 Logs

| Log | Kept |
|-----|------|
| Ingest request log | method, route, status. No IP, query string or headers (#92). Container log rotation. |
| Container logs | size rotation, 5 × 25 MB per container (`docker-compose.yml`) |
| ClickHouse system log tables | 30 days (`packages/db/clickhouse/config.d/system-logs.xml`) |
| Host journal (reverse proxy, no access log) | 30 days, at most 1 GB (`ops/host/journald-yavio.conf`) |

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
2. **Statistics:** if the field should reach the anonymous tier, extend the `stats_*` table and its query in `packages/ingest/src/stats` — through the fixed vocabulary, never as free text.
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

**Version-informed timing:** A deprecated field is not moved to "Removed" until the minimum deprecation window has elapsed.

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
