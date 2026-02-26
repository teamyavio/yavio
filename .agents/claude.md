# Yavio Analytics — Agent Guidelines

## Project Overview

Yavio is an open-source (MIT) product analytics platform for MCP Apps and ChatGPT Apps. It captures how users interact with MCP tools and ChatGPT App widgets — tool calls, conversions, funnels, retention, errors — with a 3-line SDK integration and a full analytics dashboard.

**Deployment modes:** Self-hosted (Docker) or Yavio Cloud (managed SaaS). Same codebase, same features.

## Architecture

```
Developer's MCP Server              Yavio Platform
  │                                   │
  │  @yavio/sdk                       │
  │    withYavio(server)              │
  │                                   │
  └── POST /v1/events ──────────────► Ingestion API (Fastify)
                                        │
                                        ├── PII stripping
                                        ├── Schema validation
                                        └── ClickHouse write
                                              │
  Browser ──────────────────────────► Dashboard (Next.js 16)
                                        │
                                        ├── ClickHouse (analytics)
                                        └── PostgreSQL (app data)
```

## Tech Stack

| Component | Technology |
|-----------|------------|
| SDK (`@yavio/sdk`) | TypeScript, npm package. Server: `withYavio()` proxy. Widget: `useYavio()` React hook |
| CLI (`@yavio/cli`) | TypeScript, npm package. Commands: `init`, `up`, `down`, `status`, `logs`, `update`, `reset`, `doctor` |
| Ingestion API (`packages/ingest`) | Fastify (or Hono), TypeScript |
| Dashboard (`packages/dashboard`) | Next.js 16 (App Router), React, TypeScript |
| Analytics DB | ClickHouse (ReplacingMergeTree engine) |
| Application DB | PostgreSQL 16 (Drizzle ORM) |
| Auth | NextAuth.js v5 (email+password + OAuth) |
| Package manager | pnpm (monorepo) |
| Linting/Formatting | Biome |
| Testing | Vitest (unit/integration), Playwright (E2E) |
| Deployment | Docker Compose |

## Project Structure

```
packages/
  dashboard/        # Next.js 16 dashboard (App Router)
    app/            # Routes: (auth)/, (dashboard)/[workspace]/[project]/...
    lib/            # auth/, clickhouse/, db/, queries/, email/
    components/     # charts/, layout/, ui/
  ingest/           # Fastify ingestion API
    src/routes/     # POST /v1/events
    src/middleware/  # auth, rate-limit, validate
    src/pipeline/   # pii, enrich, writer
  sdk/              # @yavio/sdk
    src/            # index.ts, tracker.ts, identify.ts, flush.ts, types.ts
  cli/              # @yavio/cli
    src/commands/   # init, up, down, status, doctor
  shared/           # Shared types and validation schemas
migrations/
  clickhouse/       # ClickHouse schema migrations (.sql)
  postgres/         # PostgreSQL schema migrations (Drizzle)
config/             # Docker service configs (ClickHouse, nginx)
specs/              # Technical specifications (read these for detailed design)
```

## Specifications

Detailed technical specs live in `specs/`. Always consult the relevant spec before implementing or modifying a component:

| Area | Spec File |
|------|-----------|
| Executive summary | `specs/01_executive-summary.md` |
| Package architecture | `specs/02_package-architecture.md` |
| SDK architecture | `specs/sdk/architecture.md` |
| Server SDK (`withYavio`) | `specs/sdk/server-sdk.md` |
| Widget SDK (`useYavio`) | `specs/sdk/react-widget-sdk.md` |
| Ingestion pipeline | `specs/ingest/event-pipeline.md` |
| Dashboard architecture | `specs/dashboard/architecture.md` |
| CLI architecture | `specs/cli/architecture.md` |
| Storage layer (schemas) | `specs/infrastructure/storage-layer.md` |
| Platform layout (Docker) | `specs/infrastructure/platform-layout.md` |
| Deployment | `specs/infrastructure/deployment.md` |
| CI/CD | `specs/infrastructure/ci-cd.md` |
| Observability | `specs/infrastructure/observability.md` |
| Metrics definitions | `specs/metrics/metrics.md` |
| Event types | `specs/metrics/events.md` |
| Error catalog | `specs/07_error-catalog.md` |
| Testing (overview) | `specs/03_testing.md` |
| Design guide | `specs/dashboard/design-guide.md` |

## Code Conventions

- **Language:** TypeScript (strict mode, no `any` unless absolutely necessary)
- **Naming:** `camelCase` for variables/functions, `PascalCase` for types/components, `SCREAMING_SNAKE_CASE` for constants
- **Imports:** Use path aliases (`@/lib/...`) within packages
- **Tests:** Colocate test files next to source (`*.test.ts`). Minimum 80% coverage.
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/) — `type(scope): description`
  - Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`
  - Scopes: `sdk`, `ingest`, `dashboard`, `cli`, `docs`
- **Branches:** `feat/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/`
- **Git workflow:** Never commit directly to `main`. Always create a feature branch, push, and open a PR via `gh pr create`.

## Key Development Commands

```bash
pnpm install              # Install dependencies
pnpm dev                  # Start dev servers
pnpm lint                 # Check formatting and lint (Biome)
pnpm lint:fix             # Auto-fix lint issues
pnpm format               # Format code
pnpm test                 # Run all tests
pnpm --filter <pkg> test  # Run tests for one package (e.g., @yavio/sdk, dashboard, ingest)
pnpm test:coverage        # Run with coverage
pnpm db:migrate           # Run database migrations
```

## Security Patterns

These patterns are critical — follow them in all new code:

### ClickHouse Tenant Isolation
- Dashboard queries go through `queryClickHouse(workspaceId, projectId, query, params)` in `lib/clickhouse/query.ts`
- This wrapper injects `SQL_workspace_id` and `SQL_project_id` as ClickHouse custom settings
- Row policies enforce isolation — individual queries do NOT need `WHERE workspace_id = ...`
- Two ClickHouse users: `yavio_ingest` (INSERT only) and `yavio_dashboard` (SELECT with row policies)

### PostgreSQL Row-Level Security
- All user-facing DB access goes through `withRLS(userId, fn)` in `lib/db/rls.ts`
- This sets `app.current_user_id` session variable — RLS policies filter automatically
- Two roles: `yavio_service` (bypasses RLS — migrations, background jobs) and `yavio_app` (RLS enforced)
- Never use the service role for user-facing queries

### API Key Security
- Keys follow format `yav_<32 random chars>`
- Only HMAC-SHA256 hash stored in DB (with server-side `API_KEY_HASH_SECRET`)
- Full key shown once at creation, never again

### PII Stripping
- The ingestion pipeline strips PII before ClickHouse storage
- Business data is preserved; identity data is removed
- PII engine is in `packages/ingest/src/pipeline/pii.ts`

### Widget Security
- Short-lived JWT (15-min expiry, write-only, trace-scoped)
- Rate limiting per token (50 events/session)
- Project API key never reaches the browser

## Database Schemas

### ClickHouse (`events` table)
The events table is the core analytics store. Key columns: `event_id`, `workspace_id`, `project_id`, `trace_id`, `session_id`, `event_type`, `event_name`, `timestamp`, `platform`, `source`, `user_id`, `user_traits`, `metadata`. See `specs/infrastructure/storage-layer.md` for the full schema.

Materialized views: `sessions_mv` (session aggregates), `users_mv` (user-level aggregates).

### PostgreSQL
Application tables: `users`, `oauth_accounts`, `sessions`, `workspaces`, `workspace_members`, `invitations`, `projects`, `api_keys`, `verification_tokens`, `login_attempts`, `stripe_webhook_events`. See `specs/infrastructure/storage-layer.md` for full DDL.

## Schema Evolution Rules

- **Additive changes only within v1.x** (new optional fields, new event types)
- New ClickHouse columns must be `Nullable` or have a `DEFAULT`
- Dashboard queries must handle `NULL` for fields that may not exist in older partitions (`ifNull`/`COALESCE`)
- The ingestion API is permissive on input: unknown fields silently dropped, missing optional fields default to NULL
- Fields are never removed within a MAJOR version — deprecation lifecycle applies

## Error Handling

All errors across the platform use the `YavioError` class from `@yavio/shared/errors`. Every error carries a stable code, human-readable message, HTTP status, and optional metadata.

### YavioError

```typescript
import { YavioError, ErrorCode } from "@yavio/shared/errors";

throw new YavioError(
  ErrorCode.DB.PG_MIGRATION_FAILED,  // stable code (never reused)
  "PostgreSQL migration failed",      // human-readable message
  500,                                 // HTTP status
  { cause: err },                      // optional metadata
);
```

The type guard `isYavioError(err)` checks whether an unknown value is a `YavioError`.

### Error Code Catalog

Codes are organized by service range in `packages/shared/src/error-codes.ts`:

| Range | Service | Object |
|-------|---------|--------|
| `YAVIO-1000` – `1999` | SDK (`@yavio/sdk`) | `ErrorCode.SDK` |
| `YAVIO-2000` – `2999` | Ingestion API | `ErrorCode.INGEST` |
| `YAVIO-3000` – `3999` | Dashboard | `ErrorCode.DASHBOARD` |
| `YAVIO-4000` – `4999` | Intelligence Service | `ErrorCode.INTELLIGENCE` |
| `YAVIO-5000` – `5999` | Database / Storage | `ErrorCode.DB` |
| `YAVIO-6000` – `6999` | CLI (`@yavio/cli`) | `ErrorCode.CLI` |
| `YAVIO-7000` – `7999` | Infrastructure | `ErrorCode.INFRA` |

Full specification: `.specs/07_error-catalog.md`

### Patterns

**Always use a code from the catalog** — never throw a bare `Error` in service code.

**Wrap unknown errors** — preserve `YavioError` if already caught, wrap otherwise:

```typescript
main().catch((err) => {
  if (err instanceof YavioError) throw err;
  throw new YavioError(
    ErrorCode.DB.CH_MIGRATION_FAILED,
    err instanceof Error ? err.message : "ClickHouse migration failed",
    500,
    { cause: err },
  );
});
```

**Include metadata** for debugging context (variable names, filenames, slugs, etc.).

### HTTP Error Response Format

All HTTP services return errors in this shape:

```json
{
  "error": {
    "code": "YAVIO-2003",
    "message": "API key has been revoked",
    "status": 401,
    "requestId": "req_a1b2c3"
  }
}
```

### Observability Integration

- **Logs:** error code in `err.code` field
- **Sentry:** code included as tag `yavio_error_code`
- **Prometheus:** error counters labeled by code

### Adding New Error Codes

1. Pick the next unused code in the appropriate service range
2. Add the constant to `packages/shared/src/error-codes.ts`
3. Document it in `.specs/07_error-catalog.md` (severity, status, message, recovery)
4. Codes are permanent — never reuse or reassign a code

## Important Implementation Notes

- The SDK uses `AsyncLocalStorage` for context propagation — import the `yavio` singleton from `@yavio/sdk` and call methods inside tool handlers
- Event transport: SDK buffers in memory, flushes HTTP batch to ingestion endpoint
- Widget auto-config: API key and endpoint injected via `window.__YAVIO__` by server-side proxy
- Dashboard uses Next.js Server Components for ClickHouse queries
- Multi-tenancy: shared infrastructure, data isolated by `workspace_id`/`project_id` columns
