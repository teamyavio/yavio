# CLI Architecture (`@yavio/cli`)

The CLI is a developer-facing command-line tool published as a standalone npm package. It lives in the platform monorepo under `packages/cli/` and provides two categories of commands: **SDK configuration** (`yavio init`) and **self-hosted platform management** (`yavio up`, `yavio down`, `yavio status`, `yavio logs`, `yavio update`, `yavio reset`, `yavio doctor`).

Developers install it globally (`npm i -g @yavio/cli`) or run it via `npx @yavio/cli`. Self-hosted operators use it as the primary interface for managing the Docker-based platform instead of running `docker-compose` directly.

## Package Definition

```json
// packages/cli/package.json
{
  "name": "@yavio/cli",
  "version": "1.0.0",
  "license": "MIT",
  "bin": {
    "yavio": "./dist/cli.mjs"
  },
  "type": "module"
}
```

## Directory Layout

```
packages/cli/
├── src/
│   ├── index.ts               # Entry point, command router (commander/yargs)
│   ├── commands/
│   │   ├── init.ts             # yavio init — interactive SDK setup, creates .yaviorc.json
│   │   ├── up.ts               # yavio up — docker-compose up -d wrapper
│   │   ├── down.ts             # yavio down — docker-compose down wrapper
│   │   ├── status.ts           # yavio status — service health, event counts, disk usage
│   │   ├── logs.ts             # yavio logs [service] — docker-compose logs wrapper
│   │   ├── update.ts           # yavio update — pull latest Docker images and restart
│   │   ├── reset.ts            # yavio reset — wipe data volumes and reinitialize
│   │   └── doctor.ts           # yavio doctor — environment diagnostics
│   └── util/
│       ├── docker.ts           # Docker/docker-compose detection and invocation
│       ├── config.ts           # .yaviorc.json read/write, config file discovery
│       └── http.ts             # Health check and API connectivity helpers
├── package.json
└── tsconfig.json
```

## Build Configuration

| Setting | Value | Notes |
|---------|-------|-------|
| Bundler | tsup | Single executable output, `--target node20` |
| Target | Node 20+ | Matches SDK requirements |
| Output | `./dist/cli.mjs` | Single ESM entry point referenced by `bin` |
| Testing | Vitest | Consistent with SDK |
| Dependencies | commander or yargs (command parsing), execa (shell execution) | Minimal dependency footprint |

## Relationship to Other Components

```
Developer workstation
  │
  │  npm i -g @yavio/cli
  │
  ├── yavio init ──────────► Creates .yaviorc.json
  │                           (auto-discovered by SDK's withYavio())
  │
  ├── yavio up ────────────► docker-compose up -d
  │                           (starts Platform services)
  │
  ├── yavio status ────────► Queries health endpoints
  │   yavio doctor             (Dashboard :3000, Ingest :3001,
  │                             ClickHouse :8123, PostgreSQL :5432)
  │
  └── yavio down ──────────► docker-compose down
```

The CLI does not depend on the SDK at runtime — it only creates the `.yaviorc.json` config file that the SDK auto-discovers. The platform management commands shell out to `docker-compose` and query service health endpoints over HTTP.

## 8.1 Command Overview

| Command | Description | Scope |
|---------|-------------|-------|
| `yavio init` | Initialize SDK in a project: create config file, prompt for API key | SDK setup |
| `yavio up` | Start the self-hosted platform (`docker-compose up -d`) | Self-hosted |
| `yavio down` | Stop the self-hosted platform (`docker-compose down`) | Self-hosted |
| `yavio status` | Show platform health: service status, event count, ClickHouse size | Self-hosted |
| `yavio logs [service]` | Tail logs for a specific service (dashboard, ingest, clickhouse, postgres) | Self-hosted |
| `yavio update` | Pull latest Docker images and restart services | Self-hosted |
| `yavio reset` | Wipe data volumes (ClickHouse events, PostgreSQL app data) and reinitialize | Self-hosted |
| `yavio doctor` | Diagnose common issues: Docker availability, port conflicts, connectivity, SDK version | Troubleshooting |

## 8.2 yavio init

Interactive setup wizard for integrating the SDK into an MCP server project.

```
$ yavio init

Yavio Setup
──────────────────────
? Enter your project API key: yav_abc123...
? Ingestion endpoint (leave blank for Yavio Cloud): https://localhost:3001
✓ Created .yaviorc.json
✓ Added .yaviorc.json to .gitignore
✓ Verified connection to ingestion API

Next steps:
  1. Import withYavio in your server:

     import { withYavio } from "@yavio/sdk";
     const instrumented = withYavio(server);

  2. withYavio() auto-reads .yaviorc.json — no config needed in code.
```

### 8.2.1 Config File (.yaviorc.json)

```json
{
  "version": 1,
  "apiKey": "yav_abc123...",
  "endpoint": "https://localhost:3001/v1/events"
}
```

The `version` field tracks the config schema version. The CLI and SDK use it to detect stale configs and apply any necessary migrations when the schema evolves in future releases.

`withYavio()` auto-discovers this file (walks up from `process.cwd()`). The developer can also pass `apiKey` and `endpoint` directly in code or via environment variables (`YAVIO_API_KEY`, `YAVIO_ENDPOINT`). Priority: code options > env vars > `.yaviorc.json`.

`yavio init` appends `.yaviorc.json` to the project's `.gitignore` if not already present. If no `.gitignore` exists, it creates one.

## 8.3 yavio up / yavio down

Thin wrappers around `docker-compose` for the self-hosted platform. The CLI uses the `docker-compose.yml` from the platform monorepo root (see [infrastructure/platform-layout.md](../infrastructure/platform-layout.md) for the full directory layout). It resolves the compose file by checking, in order: a `--file` flag, the current working directory, or the monorepo root at `yavio-platform/docker-compose.yml`.

```
$ yavio up

Starting Yavio Platform...
  ✓ postgres      (port 5432)
  ✓ clickhouse    (port 8123, 9000)
  ✓ yavio-ingest  (port 3001)
  ✓ yavio-dashboard (port 3000)

Dashboard: http://localhost:3000
Ingestion: http://localhost:3001/v1/events

$ yavio down

Stopping Yavio Platform...
  ✓ All services stopped. Data volumes preserved.
```

## 8.4 yavio status

Shows the health and state of a self-hosted Yavio deployment.

```
$ yavio status

Yavio Platform
────────────────────────
Dashboard:     http://localhost:3000 ✓ healthy
Ingestion API: http://localhost:3001 ✓ healthy
ClickHouse:    localhost:8123        ✓ healthy (2.1 GB, 1.2M events)
PostgreSQL:    localhost:5432        ✓ healthy (3 workspaces, 7 projects)
Uptime:        12 days, 4 hours

Last event:    3 seconds ago
Events today:  4,281
```

## 8.5 yavio logs

Thin wrapper around `docker-compose logs`. Defaults to following all services if no service name is provided.

```
$ yavio logs

Following all services (ctrl+c to stop)...
yavio-ingest  | 2025-06-01 12:00:01 INFO  POST /v1/events 200 (12ms, 48 events)
yavio-dashboard | 2025-06-01 12:00:02 INFO  GET /acme/hotel-booking/overview 200
clickhouse    | 2025-06-01 12:00:03 INFO  Insert 48 rows into events

$ yavio logs ingest

Following yavio-ingest (ctrl+c to stop)...
yavio-ingest  | 2025-06-01 12:00:01 INFO  POST /v1/events 200 (12ms, 48 events)
yavio-ingest  | 2025-06-01 12:00:05 INFO  POST /v1/events 200 (9ms, 23 events)
```

| Flag | Default | Description |
|------|---------|-------------|
| `[service]` | all | Service to tail: `dashboard`, `ingest`, `clickhouse`, `postgres` |
| `--lines, -n` | `100` | Number of historical lines to show before following |
| `--no-follow` | `false` | Print logs and exit instead of following |

## 8.6 yavio update

Pulls the latest Docker images for all Yavio services and restarts them. Data volumes are preserved.

```
$ yavio update

Pulling latest images...
  ✓ yavio/ingest:latest      (updated: v1.2.0 → v1.3.0)
  ✓ yavio/dashboard:latest   (updated: v1.2.0 → v1.3.0)
  · clickhouse/clickhouse-server:24.3  (unchanged)
  · postgres:16              (unchanged)

Restarting services...
  ✓ yavio-ingest
  ✓ yavio-dashboard

Update complete. Data volumes preserved.
Dashboard: http://localhost:3000
```

The command runs `docker-compose pull` followed by `docker-compose up -d` to recreate only the containers whose images changed. It skips pulling third-party images (ClickHouse, PostgreSQL) unless `--all` is passed.

| Flag | Default | Description |
|------|---------|-------------|
| `--all` | `false` | Also pull third-party images (ClickHouse, PostgreSQL) |
| `--dry-run` | `false` | Show what would be updated without pulling or restarting |

## 8.7 yavio reset

Wipes all data volumes (ClickHouse events and PostgreSQL application data) and reinitializes the platform. This is a destructive operation — the CLI requires explicit confirmation.

```
$ yavio reset

⚠ This will permanently delete all data:
  - ClickHouse: all analytics events
  - PostgreSQL: all workspaces, projects, users, API keys

Are you sure? Type "reset" to confirm: reset

Stopping services...
  ✓ All services stopped
Removing data volumes...
  ✓ postgres_data removed
  ✓ clickhouse_data removed
Starting fresh platform...
  ✓ postgres      (port 5432)
  ✓ clickhouse    (port 8123, 9000)
  ✓ yavio-ingest  (port 3001)
  ✓ yavio-dashboard (port 3000)

Platform reset complete. Create a new account at http://localhost:3000
```

| Flag | Default | Description |
|------|---------|-------------|
| `--yes --confirm-destructive` | `false` | Skip confirmation prompt (for CI/scripting). **Both flags are required together** — `--yes` alone is rejected with an error message explaining that `--confirm-destructive` is also needed. This prevents accidental data loss from muscle memory or shell history. |
| `--keep-config` | `false` | Preserve PostgreSQL data (workspaces, users, API keys) and only wipe ClickHouse events |

## 8.8 yavio doctor

Diagnoses common setup issues for both the SDK and self-hosted platform.

```
$ yavio doctor

Yavio Doctor
────────────
✓ Node.js v20.11.0 (>= 20 required)
✓ Docker v27.0.1 available
✓ docker-compose v2.28.0 available
✓ .yaviorc.json found (API key: yav_abc1...)
✓ Ingestion API reachable at http://localhost:3001
✓ API key valid (project: "hotel-booking", workspace: "acme-corp")
✓ ClickHouse accepting writes
✓ No port conflicts detected (3000, 3001, 5432, 8123)

All checks passed.
```
