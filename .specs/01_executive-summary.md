# 1. Executive Summary

This document specifies the technical architecture for the **Yavio Platform** — product analytics for MCP Apps and ChatGPT Apps. The platform consists of an open-source SDK (`@yavio/sdk`), a high-throughput event ingestion API, and a full-featured web dashboard with workspaces, team auth, and project management.

The SDK ships as an npm package with two entry points: a server-side wrapper that proxies MCP server instances for automatic analytics capture, and a React hook for tracking user interactions in ChatGPT App widgets. Together they give developers a complete picture of how users move through their app — from the initial tool call on the server to the final conversion in the widget UI. User identification (`.identify()`) ties events to known users, enabling retention analysis, per-user funnels, and cohort breakdowns. Both entry points push events over HTTP to the Yavio ingestion API, which stores them in ClickHouse.

The dashboard is a Next.js web application with workspace-based multi-tenancy, role-based access control, and team collaboration. It reads analytics data from ClickHouse and manages application state in PostgreSQL. The entire platform is open source (MIT).

The platform ships as a `docker-compose` stack for self-hosting, with an identical managed SaaS offering hosted by Yavio. Cloud pricing is usage-based: 1M events/month free, pay-as-you-go after that.

## 1.1 Scope

- **Server-side SDK:** `withYavio()` proxy wrapper for `@modelcontextprotocol/sdk`
- **Explicit tracking API:** `.identify()`, `.step()`, `.track()`, `.conversion()` methods
- **User identification:** `.identify(userId, traits)` ties events to known users, enabling retention, cohorts, and per-user analytics
- **Widget SDK:** React hook (`useYavio`) pushing events directly to the ingestion API
- **Ingestion API:** Lightweight HTTP service (Fastify/Hono) receiving event batches, validating, stripping PII, writing to ClickHouse
- **Dashboard:** Next.js 16 web application with auth, workspaces, projects, and analytics views
- **Storage:** ClickHouse (events/analytics), PostgreSQL (users, workspaces, projects, API keys)
- **CLI:** `@yavio/cli` — developer-facing command-line tool for SDK setup (`yavio init`) and self-hosted platform management (`yavio up`, `yavio down`, `yavio status`, `yavio logs`, `yavio doctor`)
- **Docker deployment:** `docker-compose` stack with all services pre-configured
- **Auth & workspaces:** Email+password and OAuth login, workspace creation, team invites, roles (admin/member/viewer)
### Analytics Tier Model

The platform has two deployment modes with a single pricing model:

| Tier | Deployment | Features | Cost |
|------|-----------|----------|------|
| **Self-Hosted (Community)** | Docker on developer's infra | Full SDK + dashboard with product analytics: user identification, retention, cohorts, funnels, paths, per-tool breakdowns, time-series, error analysis | Free / open-source |
| **Cloud** | Yavio-hosted | Same features. SDK points to Yavio's ingestion endpoint — no Docker needed. 1M events/month free, pay-as-you-go after that. | Free tier + usage-based |

### Open Source

The entire platform is open source (MIT):

| Component | License | Repository |
|-----------|---------|------------|
| SDK (`@yavio/sdk`) | MIT | Public (open source) |
| CLI (`@yavio/cli`) | MIT | Public (open source) |
| Dashboard (`yavio/dashboard`) | MIT | Public (open source) |
| Ingestion API (`yavio/ingest`) | MIT | Public (open source) |

Self-hosted and Cloud run the same codebase. Cloud monetizes through usage-based event pricing.

## 1.2 Out of Scope for v1

- Python SDK (architecture supports it; implementation deferred)
- Declarative `data-yavio-step` attribute tracking (hook-only in v1)
- Cross-project funnel analysis (traces do not span projects)

## 1.3 Key Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Instrumentation | Proxy pattern (`withYavio` wraps `McpServer`) | Best DX: 3 lines, zero config. Abstraction layer allows transport-level interception later. |
| User identification | `.identify(userId, traits)` on server + widget | Ties events to known users. Enables retention, cohorts, per-user analytics. Stored as `user_id` on events + `users_mv` materialized view. |
| Instance access (server) | Context injection + AsyncLocalStorage singleton | `ctx.yavio` for scoped handler use; singleton for deep utility functions. |
| Instance access (widget) | `useYavio()` React hook with auto-config | Zero-config: API key and endpoint auto-injected by server via `window.__YAVIO__`. |
| Event transport (server) | HTTP batch POST to ingestion API | SDK buffers events in memory, flushes to ingestion endpoint. Stateless, retryable. |
| Event transport (widget) | Direct HTTP to ingestion API | Widget sends events directly to ingestion endpoint using short-lived JWT (minted by server-side proxy). Project API key never reaches the browser. |
| Analytics storage | ClickHouse (MergeTree engine) | Purpose-built for analytics. Blazing fast aggregations over billions of rows. Column-oriented. |
| Application storage | PostgreSQL | Users, workspaces, API keys, app state. Battle-tested, great ecosystem. |
| Dashboard | Next.js 16 (App Router) | Server components for ClickHouse queries. SSR for auth pages. Single deployable container. |
| Ingestion API | Separate Fastify/Hono service | High-throughput event ingestion isolated from dashboard. Stateless, horizontally scalable. |
| SDK auth | Project API key | Each project gets a unique API key. SDK sends it as `Authorization` header. Simple, stateless. Like Mixpanel/PostHog. |
| User auth | Email+password + OAuth | Full team auth with workspaces, roles, invites. NextAuth.js v5 for session management. |
| Deployment | Docker Compose | Single `docker-compose up` starts all services. Same images used for managed SaaS. |
| Multi-tenancy | Workspace-scoped, shared infrastructure | All workspaces share ClickHouse/Postgres instances. Data isolated by workspace_id/project_id columns. |
| Security (widget) | Short-lived JWT + rate limiting + schema validation | Trace-scoped JWT (15-min expiry, write-only). Rate limiting per token (50 events/session). Schema validation rejects malformed events. Project API key never leaves the server. |
| Open-source model | Fully open source (MIT) | Entire platform open source. |
| Data capture philosophy | Store full values (PII-stripped) | Developer's own data. Full values enable richer queries and debugging. PII engine strips identity data, not business data. |
