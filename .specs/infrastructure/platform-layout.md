# Platform Layout (Docker)

The platform ships as a set of Docker images orchestrated by `docker-compose`. All services are pre-configured to work together out of the box.

## Services

### Core Services (Open Source — MIT)

| Service | Image | Role |
|---------|-------|------|
| `yavio-dashboard` | `yavio/dashboard:latest` | Next.js 16 web app: auth, workspace management, analytics views |
| `yavio-ingest` | `yavio/ingest:latest` | Fastify HTTP service: event ingestion, PII stripping, ClickHouse writes |
| - | `@yavio/sdk` (npm) | SDK: wraps MCP tools with analytics tracking, ships events to ingest API |
| `clickhouse` | `clickhouse/clickhouse-server` | Analytics event storage (MergeTree engine) |
| `postgres` | `postgres:16` | Application data: users, workspaces, projects, API keys |

### Premium Service (Proprietary — Cloud Pro / Enterprise only)

| Service | Image |
|---------|-------|
| `yavio-intelligence` | `yavio/intelligence:latest` |

The intelligence service is distributed as a private Docker image. Cloud Pro customers access it via Yavio's managed infrastructure. Enterprise On-Prem customers receive pull access to the private container registry with their license.

## Platform Directory Layout

```
yavio-platform/
├── docker-compose.yml          # Core open-source services
├── docker-compose.pro.yml      # Adds yavio-intelligence service (Pro/Enterprise)
├── docker-compose.prod.yml     # Production overrides (volumes, resource limits)
├── packages/
│   ├── dashboard/              # Next.js 16 (App Router)
│   │   ├── app/                # App Router pages
│   │   │   ├── (auth)/         # Login, register, invite acceptance
│   │   │   ├── (dashboard)/    # Protected dashboard routes
│   │   │   │   ├── [workspace]/
│   │   │   │   │   ├── [project]/
│   │   │   │   │   │   ├── overview/
│   │   │   │   │   │   ├── tools/
│   │   │   │   │   │   ├── funnels/
│   │   │   │   │   │   ├── users/
│   │   │   │   │   │   ├── paths/
│   │   │   │   │   │   ├── live/
│   │   │   │   │   │   └── errors/
│   │   │   │   │   └── settings/
│   │   │   │   └── settings/   # User settings
│   │   │   └── api/            # Next.js API routes (app-level)
│   │   ├── lib/                # Shared utilities
│   │   │   ├── auth/           # NextAuth.js v5 config
│   │   │   ├── email/          # Nodemailer transport + React Email templates
│   │   │   │   ├── transport.ts    # Nodemailer SMTP transporter (from env vars)
│   │   │   │   └── templates/      # React Email templates (verification, reset, invite, lockout)
│   │   │   ├── clickhouse/     # ClickHouse query client
│   │   │   ├── db/             # PostgreSQL client (Drizzle/Prisma)
│   │   │   └── queries/        # Analytics query builders
│   │   └── components/         # React components
│   │       ├── charts/         # Analytics chart components
│   │       ├── layout/         # Sidebar, nav, workspace switcher
│   │       └── ui/             # Design system primitives
│   ├── sdk/                    # SDK (@yavio/sdk)
│   │   ├── src/
│   │   │   ├── index.ts         # Public API: withYavio(), createYavio()
│   │   │   ├── tracker.ts       # Event tracking core
│   │   │   ├── identify.ts      # User identification (.identify())
│   │   │   ├── flush.ts         # HTTP batch flushing
│   │   │   └── types.ts         # Public type definitions
│   │   └── package.json         # "@yavio/sdk"
│   ├── ingest/                 # Ingestion API (Fastify)
│   │   ├── src/
│   │   │   ├── server.ts       # HTTP server setup
│   │   │   ├── routes/
│   │   │   │   └── events.ts   # POST /v1/events — batch event ingestion
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts     # API key validation (project lookup)
│   │   │   │   ├── rate-limit.ts # Per-key rate limiting
│   │   │   │   └── validate.ts # Schema validation
│   │   │   ├── pipeline/
│   │   │   │   ├── pii.ts      # PII stripping engine
│   │   │   │   ├── enrich.ts   # Event enrichment (workspace_id, project_id)
│   │   │   │   └── writer.ts   # ClickHouse batch writer
│   │   │   └── health.ts       # GET /health — liveness probe
│   │   └── Dockerfile
│   ├── cli/                    # CLI tool (@yavio/cli)
│   │   ├── src/
│   │   │   ├── index.ts         # Entry point, command router
│   │   │   ├── commands/        # Command implementations
│   │   │   └── util/            # Shared helpers (Docker, config discovery)
│   │   └── package.json         # "bin": { "yavio": "./dist/cli.mjs" }
│   ├── shared/                 # Shared types between dashboard and ingest
│   │   ├── events.ts           # Event schema & types
│   │   └── validation.ts       # Shared validation schemas
│   └── db/                     # Shared database layer (@yavio/db)
│       ├── src/
│       │   ├── index.ts         # Public API: clients, helpers
│       │   ├── schema.ts        # Drizzle ORM schema (PostgreSQL)
│       │   ├── client.ts        # PostgreSQL + ClickHouse clients
│       │   └── rls.ts           # Row-Level Security helpers
│       ├── drizzle/             # Drizzle-managed PostgreSQL migrations
│       ├── migrations/
│       │   └── clickhouse/      # ClickHouse schema migrations
│       └── package.json         # "@yavio/db"
└── config/
    ├── clickhouse/             # ClickHouse server config
    └── nginx/                  # Optional reverse proxy config
```
