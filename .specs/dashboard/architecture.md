# 7. Dashboard

The dashboard is a **Next.js 16 (App Router)** web application providing workspace management, team collaboration, and analytics visualization. It reads event data from ClickHouse and manages application state in PostgreSQL.

## 7.1 Architecture

### 7.1.1 Internal Architecture

```
Browser
  │
  ▼
Next.js 16 (yavio-dashboard container, port 3000)
  │
  ├─ App Router (Pages)
  │   ├─ (auth)/                              → Login, register, invite, forgot password (SSR)
  │   ├─ (dashboard)/                         → Protected analytics routes (RSC + client)
  │   │   ├─ /[workspace]/
  │   │   │   ├─ /[project]/overview          → Overview KPIs
  │   │   │   ├─ /[project]/tools             → Tool Explorer
  │   │   │   ├─ /[project]/funnels           → Funnel View
  │   │   │   ├─ /[project]/users             → User Analytics & Retention
  │   │   │   ├─ /[project]/paths             → Path Exploration
  │   │   │   ├─ /[project]/live              → Live Feed
  │   │   │   ├─ /[project]/errors            → Error Analysis
  │   │   │   └─ /settings/                   → Workspace settings, members
  │   │   │       └─ /billing                 → Billing (Cloud: Stripe, Self-hosted: Cloud upsell)
  │   │   └─ /settings                        → User settings
  │   │
  │   └─ /api/                                → API routes (see §7.9 for full reference)
  │       ├─ /auth/[...nextauth]/             → NextAuth.js v5 catch-all
  │       ├─ /workspaces/                     → Workspace CRUD
  │       ├─ /analytics/                      → Analytics query endpoints
  │       └─ /webhooks/stripe/                → Stripe webhook (YAVIO_CLOUD=true only)
  │
  ├─ Server Components        → Direct ClickHouse queries via @clickhouse/client
  ├─ Client Components        → Charts, live feed, interactive filters
  ├─ Auth (NextAuth.js v5)    → Session management, OAuth, email+password
  └─ lib/
      ├─ auth/                → NextAuth.js config, session helpers
      ├─ email/               → Nodemailer transport + React Email templates (see §7.11)
      ├─ clickhouse/          → ClickHouse query client (injects SQL_workspace_id/SQL_project_id settings per query; see storage-layer.md §5.1.8)
      ├─ db/                  → PostgreSQL client (Drizzle ORM) + withRLS() transaction wrapper (see storage-layer.md §5.2.10)
      ├─ queries/             → Analytics query builders (ClickHouse SQL)
      ├─ intelligence/        → Intelligence service HTTP client
      └─ billing/             → Stripe integration (gated by YAVIO_CLOUD)
```

### 7.1.2 External Data Flow

```
                    ┌─────────────────────────────────────────────────────┐
                    │                    Browser                          │
                    │  (React client components, charts, live feed)       │
                    └───────────────────────┬─────────────────────────────┘
                                            │
                              Session cookie │ (httpOnly, secure, SameSite=Lax)
                                            │
                    ┌───────────────────────▼─────────────────────────────┐
                    │         yavio-dashboard (Next.js 16, :3000)         │
                    │                                                     │
                    │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
                    │  │  Server   │  │  API     │  │  NextAuth.js v5  │  │
                    │  │Components │  │  Routes  │  │  (session mgmt)  │  │
                    │  └────┬─────┘  └────┬─────┘  └────────┬─────────┘  │
                    └───────┼─────────────┼─────────────────┼────────────┘
                            │             │                 │
               ┌────────────┘    ┌────────┘                 │
               │                 │                          │
        ┌──────▼──────┐   ┌─────▼───────┐           ┌──────▼──────┐
        │  ClickHouse  │   │ Intelligence │           │  PostgreSQL  │
        │   (events,   │   │  Service     │           │  (users,     │
        │  sessions)   │   │  (:4000)     │           │  workspaces, │
        │    :8123     │   │  [optional]  │           │  projects,   │
        └──────────────┘   └─────────────┘           │  API keys)   │
                                                      │    :5432     │
                                                      └─────────────┘
                                                             ▲
                                                             │
                                                      ┌──────┴──────┐
                                                      │   Stripe    │
                                                      │  (webhooks) │
                                                      │ [Cloud only]│
                                                      └─────────────┘
```

**Data flow summary:**
- **ClickHouse** ← Server Components read analytics data (events, sessions, metrics) via `lib/clickhouse/query.ts`, which injects `SQL_workspace_id` / `SQL_project_id` custom settings on every query. ClickHouse row policies enforce tenant isolation at the database level. See [storage-layer.md §5.1.8](../infrastructure/storage-layer.md#518-row-policies-tenant-isolation).
- **PostgreSQL** ← API Routes read/write application state (users, workspaces, projects, API keys, billing) via Drizzle ORM wrapped in `withRLS()`, which sets `app.current_user_id` per transaction. PostgreSQL RLS policies enforce tenant isolation at the database level. NextAuth.js internals use the `yavio_service` role which bypasses RLS. See [storage-layer.md §5.2.10](../infrastructure/storage-layer.md#5210-row-level-security-tenant-isolation).
- **Intelligence Service** ← Server Components call premium analytics endpoints over internal HTTP (graceful degradation if unavailable)
- **Stripe** → Webhook pushes billing events to `/api/webhooks/stripe` (Cloud deployments only)

### 7.1.3 Technology Choices

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Framework | Next.js 16 (App Router) | Server Components for direct DB queries. SSR for auth pages. Single container. |
| Auth | NextAuth.js v5 | Session management, OAuth providers, email+password. Industry-standard, well-maintained, with built-in Drizzle adapter. |
| ClickHouse client | @clickhouse/client | Official Node.js client. Streaming support. |
| PostgreSQL ORM | Drizzle ORM | Type-safe, lightweight, great DX. Migrations included. |
| Charts | Recharts 3.x (via shadcn/ui chart components) + @nivo/sankey | Recharts: shadcn/ui's official charting foundation (53 pre-built components), 13.8M weekly downloads, composable React API. @nivo/sankey: best-in-class React Sankey component with built-in theming. |
| Styling | Tailwind CSS + shadcn/ui | Utility-first CSS. shadcn for pre-built accessible components. |

## 7.2 Authentication & Authorization

### 7.2.1 Auth Flows

| Flow | Method | Details |
|------|--------|---------|
| Register | Email + password | Create account → verify email (mandatory) → create default workspace. Users cannot access the dashboard, create workspaces, generate API keys, or ingest events until email is verified. Unverified accounts are auto-deleted after 24 hours. |
| Login | Email + password | Session cookie (httpOnly, secure, SameSite=Lax) |
| OAuth | GitHub, Google | Link to existing account or create new. Auto-create workspace on first login. |
| Invite | Email link | Invited user clicks link → register or login → auto-join workspace with assigned role |
| Forgot password | Email reset link | Time-limited token (1 hour). Invalidates on use. |

### 7.2.2 Roles & Permissions

| Role | Dashboard Access | Workspace Settings | Manage Members | Manage Projects | API Keys |
|------|-----------------|-------------------|----------------|-----------------|----------|
| **Admin** | Full | Full | Invite, remove, change roles | Create, delete, rename | Create, revoke |
| **Member** | Full | View only | View members | View projects | View keys (masked) |
| **Viewer** | Read-only (no export) | None | None | None | None |

The workspace owner is always an Admin and cannot be removed or downgraded.

## 7.3 Workspace & Project Management

### 7.3.1 Workspace

A workspace is the top-level organizational unit. It maps to a team or company.

- Every user gets a default personal workspace on registration
- Users can create additional workspaces
- Each workspace has a unique slug used in URLs (`/acme-corp/...`)
- Plan (community/cloud_free/cloud_pro/enterprise) is set at the workspace level

### 7.3.2 Projects

A project represents a single MCP server or application being instrumented.

- Projects live within a workspace
- Each project has one or more API keys
- API keys are scoped to a project (one key = one project)
- The project selector in the dashboard sidebar allows switching between projects
- Each project has its own slug, unique within the workspace (`/acme-corp/hotel-booking/...`)

### 7.3.3 API Key Management

Dashboard pages for API key lifecycle:

- **Create:** Generate new key for a project. Full key shown once, then only the prefix (`yav_abc1...`) is visible.
- **List:** Show all keys for a project with name, prefix, creation date, last used.
- **Revoke:** Soft-delete (sets `revoked_at`). Immediately stops accepting events from that key.
- **Rotate:** Create new key + revoke old key in one action. Grace period option (old key remains valid for N minutes).

## 7.4 Intelligence Service Integration (coming in V2)

The dashboard communicates with the proprietary `yavio-intelligence` service via internal HTTP API to power premium features. This integration is designed for graceful degradation — the dashboard works fully without the intelligence service.

## 7.5 Analytics Views (v1)

The v1 dashboard provides product analytics for MCP Apps and ChatGPT Apps: user identification, retention analysis, time-series charts, per-tool breakdowns, combined server+widget funnels, path exploration, and real-time event feeds. Advanced intelligence are powered by the intelligence service (Cloud Pro / Enterprise). Where the intelligence service is not available, the dashboard displays placeholder cards with "Available with Cloud Pro" messaging.

The v1 dashboard includes seven views, designed to answer the most important questions an MCP App and ChatGPT App developer has:

### 7.5.1 Overview

Top-level KPIs and trends. Answers: **"How is my app doing overall?"**

See [metrics/metrics.md — Overview KPIs](metrics/metrics.md#overview-kpis) and [Business KPIs](metrics/metrics.md#business-kpis) for the full list of metrics surfaced in this view.

### 7.5.2 Tool Explorer

Per-tool deep dive. Answers: **"How is each tool performing?"**

See [metrics/metrics.md — Tool Explorer Metrics](metrics/metrics.md#tool-explorer-metrics) for the full list of metrics surfaced in this view.

### 7.5.3 Funnel View

Combined server + widget funnel. Answers: **"Where do users drop off?"**

See [metrics/metrics.md — Funnel Metrics](metrics/metrics.md#funnel-metrics) for the full list of metrics surfaced in this view.

- Filter by time range, platform, tool

### 7.5.4 Live Feed

Real-time event stream. Answers: **"What's happening right now?"**

- Scrolling event list, auto-updates via Server-Sent Events from the dashboard API
- Color-coded by event type (tool_call, step, conversion, error)
- Click to expand: full event details
- Pause/resume stream
- The SSE endpoint queries ClickHouse on a short poll interval (1–2 seconds) for new events matching the current project

### 7.5.5 Errors

Error analysis view. Answers: **"What's going wrong?"**

See [metrics/metrics.md — Error Metrics](metrics/metrics.md#error-metrics) for the full list of metrics surfaced in this view.

### 7.5.6 Users

User-level analytics view. Answers: **"Who are my users and are they coming back?"**

Requires `.identify()` to be called in the SDK. Sessions without `.identify()` appear as anonymous.

- **User list:** Table of identified users with key metrics (sessions, tool calls, conversions, revenue, first seen, last seen)
- **Retention cohorts:** Matrix showing "Of users who first used the app in week N, what % returned in week N+1, N+2, etc." Configurable by day/week/month.
- **DAU / WAU / MAU:** Daily, weekly, and monthly active users over time (line chart)
- **Stickiness:** Distribution of how many days per week/month users are active
- **New vs returning:** Time-series breakdown of new users vs returning users per period
- **User detail:** Click into a user to see their full event timeline across sessions, tool calls, funnel progression, and conversions
- Filter by time range, platform, user traits

See [metrics/metrics.md — User Metrics](metrics/metrics.md#user-metrics) for the full list of metrics surfaced in this view.

### 7.5.7 Paths

User path exploration. Answers: **"What sequences of actions do users take?"**

Unlike the Funnel View (which tracks a pre-defined sequence of steps), the Paths view is exploratory — it visualizes the actual sequences of tools and steps users take, revealing unexpected patterns.

- **Sunburst / Sankey diagram:** Visualize the most common tool call sequences (e.g., `search_rooms` → `get_details` → `book_room` vs. `search_rooms` → `search_rooms` → abandon)
- **Starting point filter:** "Show me all paths that start with tool X"
- **Ending point filter:** "Show me all paths that end with conversion Y"
- **Drop-off paths:** Highlight paths where users abandon (no conversion)
- Filter by time range, platform, user traits

## 7.6 Identify Integration

All user-level views (Users, Paths, retention, DAU/WAU/MAU) require `.identify()` to have been called in the SDK. `.identify()` should be called at the beginning of a session (or multiple times if user context changes). The dashboard handles the absence of identified users gracefully:

- **No `.identify()` calls in project:** Users view shows an empty state with instructions on how to add `.identify()` to the SDK integration.
- **Partial adoption:** Sessions without `.identify()` are counted as anonymous. Metrics clearly distinguish between identified and anonymous sessions.

## 7.7 Multi-Project Support

The dashboard sidebar contains a workspace switcher (top) and project selector (below it). All analytics views are scoped to the currently selected project. The overview page can optionally show aggregate metrics across all projects in the workspace.

Cross-project funnel analysis is not supported in v1 (traces do not span projects). This is a Cloud Pro feature (via intelligence service).

## 7.8 Onboarding Flow

When a user creates a new workspace and project, the dashboard guides them through setup:

1. **Create workspace** — name and slug
2. **Create first project** — name (e.g., "Hotel Booking MCP")
3. **Generate API key** — show full key with copy button
4. **Show integration snippet:**

```typescript
import { withYavio } from "@yavio/sdk";

const instrumented = withYavio(server, {
  apiKey: "yav_abc123...",
  endpoint: "https://your-instance:3001/v1/events", // or omit for Yavio Cloud
});
```

5. **Wait for first event** — real-time check, shows success animation when first event arrives
6. **Redirect to dashboard** — overview page with first data

## 7.9 Dashboard API Routes

All dashboard API routes live under `/api/` in the Next.js App Router. Routes are grouped by domain: authentication, workspace management, analytics queries, live feed, and billing.

### 7.9.1 Authentication Routes

Handled by NextAuth.js v5 via the catch-all route handler at `app/api/auth/[...nextauth]/route.ts`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET/POST | `/api/auth/[...nextauth]` | Varies | NextAuth.js catch-all handler (see sub-routes below) |

**NextAuth.js sub-routes (handled automatically):**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/session` | Get current session (returns user, workspace memberships) |
| GET | `/api/auth/providers` | List configured auth providers (credentials, github, google) |
| GET | `/api/auth/csrf` | Get CSRF token for form submissions |
| POST | `/api/auth/signin/credentials` | Sign in with email + password |
| POST | `/api/auth/signin/github` | Initiate GitHub OAuth flow |
| POST | `/api/auth/signin/google` | Initiate Google OAuth flow |
| GET | `/api/auth/callback/github` | GitHub OAuth callback (exchanges code for session) |
| GET | `/api/auth/callback/google` | Google OAuth callback (exchanges code for session) |
| POST | `/api/auth/signout` | Sign out (clears session cookie) |

**Custom auth routes (alongside NextAuth):**

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | None | Create account (email, password, name). Creates default workspace. Sends verification email. |
| POST | `/api/auth/forgot-password` | None | Send password reset email. Token valid for 1 hour. |
| POST | `/api/auth/reset-password` | None | Reset password using token from email link. Invalidates token on use. |
| POST | `/api/auth/verify-email` | None | Verify email address using token from verification email. |
| GET | `/api/auth/invite/[token]` | None | Validate invite token and return workspace info. Used by invite acceptance page. |
| POST | `/api/auth/invite/[token]/accept` | Session | Accept workspace invitation. Adds user to workspace with assigned role. |
| DELETE | `/api/auth/account` | Session | Delete user account. Removes user from all workspaces. Deletes owned workspaces (and their projects, keys, and ClickHouse data). Revokes session. Irreversible. Requires password confirmation in request body. |

### 7.9.2 Workspace Routes

All workspace routes require an authenticated session. Authorization is enforced per the role matrix in §7.2.2.

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| POST | `/api/workspaces` | Session | Any | Create a new workspace (name, slug). Creator becomes Admin. |
| GET | `/api/workspaces` | Session | Any | List workspaces the current user belongs to. |
| GET | `/api/workspaces/[workspaceId]` | Session | Any member | Get workspace details (name, slug, plan, member count). |
| PATCH | `/api/workspaces/[workspaceId]` | Session | Admin | Update workspace (name, slug). |
| DELETE | `/api/workspaces/[workspaceId]` | Session | Owner | Delete workspace and all associated projects, keys, and event data (PostgreSQL rows and ClickHouse events). Irreversible. |

### 7.9.3 Member Routes

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| GET | `/api/workspaces/[workspaceId]/members` | Session | Any member | List workspace members (id, name, email, role, joined date). |
| POST | `/api/workspaces/[workspaceId]/members/invite` | Session | Admin | Invite user by email. Sends invitation email with accept link. Body: `{ email, role }`. |
| PATCH | `/api/workspaces/[workspaceId]/members/[memberId]` | Session | Admin | Update member role. Cannot downgrade workspace owner. Body: `{ role }`. |
| DELETE | `/api/workspaces/[workspaceId]/members/[memberId]` | Session | Admin | Remove member from workspace. Cannot remove workspace owner. |
| GET | `/api/workspaces/[workspaceId]/invitations` | Session | Admin | List pending invitations (email, role, invited date, status). |
| DELETE | `/api/workspaces/[workspaceId]/invitations/[invitationId]` | Session | Admin | Cancel a pending invitation. |

### 7.9.4 Project Routes

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| POST | `/api/workspaces/[workspaceId]/projects` | Session | Admin | Create project (name, slug). Body: `{ name }`. Slug auto-generated from name. |
| GET | `/api/workspaces/[workspaceId]/projects` | Session | Any member | List projects in workspace (id, name, slug, event count, created date). |
| GET | `/api/workspaces/[workspaceId]/projects/[projectId]` | Session | Any member | Get project details. |
| PATCH | `/api/workspaces/[workspaceId]/projects/[projectId]` | Session | Admin | Update project (name, slug). Body: `{ name?, slug? }`. |
| DELETE | `/api/workspaces/[workspaceId]/projects/[projectId]` | Session | Admin | Delete project, associated API keys, and all event data in ClickHouse for this project. Irreversible. |

### 7.9.5 API Key Routes

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| POST | `/api/workspaces/[workspaceId]/projects/[projectId]/keys` | Session | Admin | Create API key. Returns full key once (`yav_...`). Body: `{ name }`. |
| GET | `/api/workspaces/[workspaceId]/projects/[projectId]/keys` | Session | Any member | List API keys (name, prefix, created date, last used). Full key never returned. Viewers see masked keys. |
| DELETE | `/api/workspaces/[workspaceId]/projects/[projectId]/keys/[keyId]` | Session | Admin | Revoke API key (soft-delete, sets `revoked_at`). Immediately stops accepting events. |
| POST | `/api/workspaces/[workspaceId]/projects/[projectId]/keys/[keyId]/rotate` | Session | Admin | Rotate key: create new + revoke old. Body: `{ gracePeriodMinutes?: number }`. Returns new full key. |

### 7.9.6 Analytics Query Routes

All analytics routes require an authenticated session and are scoped to the specified project. They query ClickHouse via server-side query builders in `lib/queries/`. Common query parameters are listed first, then per-route specifics.

**Common query parameters (all analytics routes):**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `from` | ISO-8601 | 7 days ago | Start of time range |
| `to` | ISO-8601 | Now | End of time range |
| `platform` | string | All | Filter by platform (`chatgpt`, `claude`, `cursor`, `vscode`) |
| `granularity` | string | `day` | Time bucketing (`hour`, `day`, `week`, `month`) |

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/analytics/[projectId]/overview` | Session | Overview KPIs: total sessions, tool calls, conversions, error rate, avg duration, DAU, revenue. Time-series for each metric. See [metrics.md — Overview KPIs](metrics/metrics.md#overview-kpis). |
| GET | `/api/analytics/[projectId]/tools` | Session | Per-tool breakdown: call count, success rate, avg duration, error rate, popularity rank. Query params: `tool` (filter to specific tool), `page`, `pageSize`, `sort`, `order`. See [metrics.md — Tool Explorer](metrics/metrics.md#tool-explorer-metrics). |
| GET | `/api/analytics/[projectId]/funnels` | Session | Funnel metrics: step-by-step conversion rates, drop-off points, median time between steps. Query param: `funnelId` (predefined funnel). See [metrics.md — Funnel Metrics](metrics/metrics.md#funnel-metrics). |
| GET | `/api/analytics/[projectId]/users` | Session | User analytics: identified user list, session counts, conversion rates. Query params: `page`, `pageSize`, `sort`, `order`. See [metrics.md — User Metrics](metrics/metrics.md#user-metrics). |
| GET | `/api/analytics/[projectId]/users/[userId]` | Session | User detail: full event timeline across sessions, tool calls, funnel progression, conversions. |
| GET | `/api/analytics/[projectId]/users/retention` | Session | Retention cohort matrix. Query param: `period` (`day`, `week`, `month`). |
| GET | `/api/analytics/[projectId]/users/active` | Session | DAU / WAU / MAU time-series. Stickiness distribution. New vs returning breakdown. |
| GET | `/api/analytics/[projectId]/paths` | Session | Path sequences: tool call sequences as Sankey/sunburst data. Query params: `startTool`, `endTool` (filter starting/ending points). |
| GET | `/api/analytics/[projectId]/errors` | Session | Error metrics: error count by type, top erroring tools, error rate time-series, error details. Query params: `page`, `pageSize`, `sort`, `order`, `errorCategory` (filter). See [metrics.md — Error Metrics](metrics/metrics.md#error-metrics). |

### 7.9.7 Live Feed Route

| Method | Path | Auth | Protocol | Description |
|--------|------|------|----------|-------------|
| GET | `/api/analytics/[projectId]/live` | Session | SSE | Server-Sent Events stream. Polls ClickHouse every 1–2 seconds for new events matching the project. Events are color-coded by type (`tool_call`, `step`, `conversion`, `error`). Client auto-reconnects on disconnect. Query param: `eventType` (optional filter). |

**SSE event format:**

```
event: event
data: {"id":"evt_xxx","eventType":"tool_call","eventName":"search_rooms","timestamp":"2026-03-15T10:30:00Z","traceId":"tr_xxx","sessionId":"ses_xxx","platform":"chatgpt","metadata":{...}}

event: heartbeat
data: {"timestamp":"2026-03-15T10:30:02Z"}
```

### 7.9.8 Billing Routes (Cloud Only)

All billing routes are gated by `YAVIO_CLOUD=true`. When not set, billing API routes return a `{"cloud": false}` response directing clients to the Cloud upsell UI.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/billing/[workspaceId]/checkout` | Session (Admin) | Create Stripe Checkout Session in `setup` mode (payment method collection, no charge). Returns `{ url }` redirect to Stripe. |
| GET | `/api/billing/[workspaceId]/usage` | Session (Any member) | Current billing period usage: events this month, cost breakdown by tier, projected monthly cost, spending cap status. |
| PATCH | `/api/billing/[workspaceId]/spending-cap` | Session (Admin) | Set or update monthly spending cap. Body: `{ cap: number }`. Set `0` to remove cap. |
| GET | `/api/billing/[workspaceId]/portal` | Session (Admin) | Generate Stripe Customer Portal URL for invoice history, payment method management. Returns `{ url }`. |
| POST | `/api/webhooks/stripe` | Stripe signature | Stripe webhook handler. Verifies `Stripe-Signature` header (HMAC-SHA256). See §7.9.8.1 for handled events. |

#### 7.9.8.1 Stripe Webhook Events

| Stripe Event | Dashboard Action |
|-------------|-----------------|
| `checkout.session.completed` | Store Stripe customer ID, create usage-based subscription ($0 base + metered events) |
| `customer.subscription.updated` | Sync billing status (`active`, `past_due`) in PostgreSQL |
| `customer.subscription.deleted` | Remove payment method, revert workspace to free tier |
| `invoice.payment_failed` | Mark workspace as `past_due`, show warning banner in dashboard |
| `invoice.paid` | Clear `past_due` status |

### 7.9.9 Health Route

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | None | Liveness probe. Returns `{ status, services: { postgres, clickhouse } }`. Used by Docker health checks and `yavio status` CLI command. |

### 7.9.10 Rate Limiting

All API routes are rate-limited to protect against abuse and prevent expensive ClickHouse queries from degrading the service.

| Route Group | Limit | Window | Key |
|-------------|-------|--------|-----|
| Auth (login, register, forgot-password) | 10 requests | 1 minute | IP address |
| Auth (invite validation `GET /api/auth/invite/[token]`) | 10 requests | 1 minute | IP address |
| Auth (all other) | 30 requests | 1 minute | IP address |
| Analytics query routes | 60 requests | 1 minute | Session user ID |
| Live Feed (SSE) | 5 concurrent connections | — | Session user ID |
| Workspace / Project / Key management | 30 requests | 1 minute | Session user ID |
| Billing | 20 requests | 1 minute | Session user ID |
| Stripe webhook | 100 requests | 1 minute | IP address |
| Health | 60 requests | 1 minute | IP address |

**Implementation:** Use a middleware-based rate limiter (e.g., `@upstash/ratelimit` with in-memory or Redis store). Rate limit responses return `429 Too Many Requests` with a `Retry-After` header. Analytics routes should also debounce rapid filter changes on the client side (300ms debounce recommended).

### 7.9.11 Route Summary

**Pagination defaults:** All paginated routes default to `page=1`, `pageSize=25`, `sort` by primary metric (descending), `order=desc`. Maximum `pageSize` is 100.

| Group | Base Path | Routes | Auth | Data Source |
|-------|-----------|--------|------|-------------|
| Auth | `/api/auth/` | 13 | None / Session | PostgreSQL |
| Workspaces | `/api/workspaces/` | 5 | Session | PostgreSQL |
| Members | `/api/workspaces/[wId]/members/` | 6 | Session (Admin for writes) | PostgreSQL |
| Projects | `/api/workspaces/[wId]/projects/` | 5 | Session (Admin for writes) | PostgreSQL |
| API Keys | `/api/workspaces/[wId]/projects/[pId]/keys/` | 4 | Session (Admin for writes) | PostgreSQL |
| Analytics | `/api/analytics/[projectId]/` | 9 | Session | ClickHouse |
| Live Feed | `/api/analytics/[projectId]/live` | 1 | Session | ClickHouse (SSE) |
| Billing | `/api/billing/[workspaceId]/` | 5 | Session / Stripe signature | PostgreSQL + Stripe |
| Health | `/api/health` | 1 | None | PostgreSQL + ClickHouse |
| **Total** | | **49** | | |

### 7.9.12 Cross-Service API Reference

The dashboard is one of three HTTP services in the Yavio platform. For completeness, the other service APIs are documented in their respective specs:

| Service | Port | Spec | Key Endpoints |
|---------|------|------|---------------|
| **Ingestion API** (`yavio-ingest`) | 3001 | [ingest/event-pipeline.md](../ingest/event-pipeline.md) | `POST /v1/events` (batch ingestion), `POST /v1/widget-tokens` (mint widget JWT), `GET /health` |

## 7.11 Email Sending

### 7.11.1 Transport

All outbound email (verification, password reset, invitations, lockout notifications) is sent via **Nodemailer** configured through SMTP environment variables. This follows the standard pattern used by comparable open-source projects (Cal.com, Formbricks, Documenso, Hoppscotch, Infisical) — SMTP is the universal abstraction, and operators point the env vars at whichever provider they prefer.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SMTP_HOST` | No | - | SMTP server hostname (e.g., `smtp.resend.com`, `email-smtp.us-east-1.amazonaws.com`, `smtp.gmail.com`) |
| `SMTP_PORT` | No | `587` | SMTP port (`587` for STARTTLS, `465` for TLS) |
| `SMTP_USER` | No | - | SMTP authentication username |
| `SMTP_PASSWORD` | No | - | SMTP authentication password |
| `SMTP_FROM` | No | `noreply@localhost` | Default `From` address for outbound email |

**When SMTP is not configured** (no `SMTP_HOST` set), the dashboard operates in **email-disabled mode**:
- Registration skips the email verification step (accounts are immediately active)
- Password reset and invite features are disabled in the UI with a message: "Email is not configured. Set SMTP environment variables to enable this feature."
- Account lockout notifications are logged but not emailed

This ensures the platform works out of the box for local development and simple self-hosted setups without requiring an SMTP server.

**Implementation:** A single `lib/email/transport.ts` module creates the Nodemailer transporter at startup:

```typescript
import { createTransport, type Transporter } from "nodemailer";

let transporter: Transporter | null = null;

if (process.env.SMTP_HOST) {
  transporter = createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });
}

export { transporter };
```

All email-sending functions check `if (!transporter)` before attempting to send and degrade gracefully.

### 7.11.2 Templates

Email templates are built with **React Email** (`@react-email/components`) as React components, rendered to HTML via `@react-email/render`. Templates live in `lib/email/templates/`.

| Template | Trigger | Content |
|----------|---------|---------|
| `verification.tsx` | `POST /api/auth/register` | Verification link with 24-hour token |
| `password-reset.tsx` | `POST /api/auth/forgot-password` | Reset link with 1-hour token |
| `invitation.tsx` | `POST /api/workspaces/[wId]/members/invite` | Workspace invite with accept link |
| `account-locked.tsx` | 25+ or 50+ failed login attempts | Lockout notification with unlock/reset instructions |

Templates have **no business logic** — they receive pre-processed data and return HTML. All token generation, database queries, and validation happen in the calling API route.

### 7.11.3 Deployment Configuration

- **Self-hosted (local dev):** Leave `SMTP_HOST` unset. Email features gracefully disabled.
- **Self-hosted (production):** Set SMTP vars to any provider (Amazon SES, Mailgun, Gmail, self-hosted Postfix, etc.)
- **Yavio Cloud:** SMTP vars point to the cloud provider's chosen email service (e.g., `smtp.resend.com` or Amazon SES)

No code difference between self-hosted and cloud — only different environment variable values.

## 7.10 Security

### 7.10.1 HTTP Security Headers

All dashboard responses include the following security headers, configured via Next.js middleware or `next.config.js`:

| Header | Value | Purpose |
|--------|-------|---------|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Enforce HTTPS for 1 year. Only set when `NEXTAUTH_URL` uses `https://`. |
| `X-Content-Type-Options` | `nosniff` | Prevent MIME-type sniffing |
| `X-Frame-Options` | `DENY` | Prevent clickjacking on dashboard pages. Does not apply to widget iframes (served by the MCP server, not the dashboard). |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limit referrer leakage |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | Disable unnecessary browser APIs |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://ingest.yavio.ai; frame-ancestors 'none';` | Restrict resource loading. `unsafe-inline` required for Next.js and Tailwind. `connect-src` allows ingestion API calls. `frame-ancestors 'none'` prevents embedding. |

### 7.10.2 CSRF Protection

All state-modifying POST/PATCH/DELETE routes require CSRF protection:

- **NextAuth routes:** CSRF is handled automatically by NextAuth.js v5 (double-submit cookie pattern via `/api/auth/csrf`).
- **Custom auth routes** (`/api/auth/register`, `/api/auth/forgot-password`, `/api/auth/reset-password`, `/api/auth/verify-email`): Require the CSRF token from NextAuth's `/api/auth/csrf` endpoint in the `X-CSRF-Token` header. The middleware validates the token before processing the request.
- **All other API routes** (workspaces, projects, analytics, billing): Protected by session cookies with `SameSite=Lax`, which prevents cross-origin form submissions. Additionally, the middleware validates the `Origin` header on all non-GET requests — requests from origins other than `NEXTAUTH_URL` are rejected with `403 Forbidden`.

### 7.10.3 Account Lockout

To prevent distributed brute-force attacks that bypass IP-based rate limiting:

| Trigger | Action | Duration |
|---------|--------|----------|
| 10 failed login attempts for the same email within 15 minutes | Lock account | 15 minutes (auto-unlock) |
| 25 failed login attempts for the same email within 1 hour | Lock account + notify user via email | 1 hour (auto-unlock) |
| 50 failed login attempts for the same email within 24 hours | Lock account + notify user via email + require CAPTCHA on unlock | Manual unlock via email link or password reset |

**Implementation:** Failed login attempts are tracked in a `login_attempts` PostgreSQL table (`email`, `attempted_at`, `ip_address`). The table is cleaned up daily (rows older than 24 hours). The lockout check runs before password verification to avoid timing attacks.

**Account lockout does not apply to OAuth logins** — OAuth providers handle their own brute-force protection.
