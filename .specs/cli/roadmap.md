# CLI Roadmap

## Phase 7: CLI & Docker Packaging

### Step 1 — Package Scaffolding

- Create `packages/cli/` directory structure per [architecture.md](./architecture.md)
- `package.json` with `"bin": { "yavio": "./dist/cli.mjs" }`, `type: "module"`
- Dependencies: `commander` (command framework), `execa` (shell execution), `picocolors` (terminal colors), `ora` (spinners)
- `tsconfig.json` extending `../../tsconfig.base.json`, NodeNext modules, ES2022 target
- `tsup.config.ts` — single ESM entry (`src/index.ts` → `dist/cli.mjs`), `--target node20`, banner with shebang `#!/usr/bin/env node`
- `vitest.config.ts` consistent with other packages
- Add `@yavio/cli` to pnpm workspace (already covered by `packages/*` glob)
- Verify: `pnpm turbo build --filter=@yavio/cli` produces `dist/cli.mjs`

### Step 2 — Command Framework & Shared Utilities

- Entry point (`src/index.ts`): Commander program with version from `package.json`, global `--verbose` flag, help text
- `src/util/config.ts`: `.yaviorc.json` read/write, walk-up directory discovery (same logic as SDK), schema version validation
- `src/util/docker.ts`: detect `docker` and `docker compose` (v2) availability, compose file resolution (`--file` flag → cwd → error), `execCompose()` helper wrapping `execa`
- `src/util/http.ts`: health check polling with timeout, JSON fetch helper for status/doctor endpoints
- `src/util/output.ts`: consistent formatting helpers — spinners (ora), success/error/warning prefixes, table output
- Unit tests for all utilities: config discovery, Docker detection (mocked), HTTP helpers (mocked)

### Step 3 — `yavio init`

- Interactive prompts: API key input (masked), endpoint input (default: empty = Yavio Cloud)
- Validate API key format (`yav_` prefix)
- Write `.yaviorc.json` with `{ version: 1, apiKey, endpoint }`
- Append `.yaviorc.json` to `.gitignore` (create `.gitignore` if absent, skip if already listed)
- Verify connection: `GET <endpoint>/health` — warn if unreachable, proceed anyway
- Print next-steps guide (import snippet)
- Non-interactive mode: `yavio init --api-key <key> --endpoint <url>` for CI/scripting
- Unit tests: config file creation, `.gitignore` handling (exists/missing/already-listed), API key format validation

### Step 4 — `yavio up` / `yavio down`

- `yavio up`: resolve compose file → `docker compose up -d` → poll health endpoints until all services healthy (30s timeout) → print service URLs
- `yavio down`: `docker compose down` → confirm services stopped, print "data volumes preserved"
- `yavio up --build`: pass `--build` to compose for local dev (rebuild images from source)
- Pretty output: spinner per service during startup, checkmark on healthy
- Error handling: compose file not found, Docker not installed, port conflicts (detect before starting)
- Pre-flight: check required env vars (`NEXTAUTH_SECRET`, `JWT_SECRET`, `API_KEY_HASH_SECRET`, `ENCRYPTION_KEY`) — warn if `.env` is missing or required vars unset
- Unit tests: compose command construction, health polling logic, env var validation
- Integration test (optional, CI-skippable): `yavio up` → health checks pass → `yavio down`

### Step 5 — `yavio status`

- Query health endpoints: dashboard (`:3000/api/health`), ingest (`:3001/health`)
- Query ClickHouse via HTTP: event count (`SELECT count() FROM events`), disk usage (`SELECT formatReadableSize(sum(bytes_on_disk))`)
- Query PostgreSQL stats via dashboard health endpoint (extend if needed): workspace count, project count
- Calculate uptime from container start time (`docker compose ps --format json`)
- Display last event timestamp, events today count
- Formatted table output matching the spec in architecture.md
- Handle partial availability gracefully (some services down)
- Unit tests: output formatting, health status parsing, partial failure handling

### Step 6 — `yavio logs`

- `yavio logs [service]`: default to all services, optional service filter (`dashboard`, `ingest`, `clickhouse`, `postgres`)
- `--lines, -n <number>`: historical lines (default 100)
- `--no-follow`: print and exit instead of tailing
- Service name mapping: friendly names → compose service names
- Delegate to `docker compose logs` with appropriate flags
- Unit tests: flag parsing, service name resolution

### Step 7 — `yavio update`

- `docker compose pull` for Yavio images (ingest, dashboard)
- Compare image digests before/after to detect actual updates
- `docker compose up -d` to recreate only changed containers
- `--all` flag: also pull third-party images (postgres, clickhouse)
- `--dry-run` flag: show what would be updated without pulling
- Print version change summary (old digest → new digest, or "unchanged")
- Unit tests: digest comparison logic, flag handling

### Step 8 — `yavio reset`

- Destructive operation: require interactive confirmation (type "reset" to confirm)
- `--yes --confirm-destructive`: skip prompt (both flags required together, `--yes` alone rejected)
- `--keep-config`: wipe only ClickHouse events, preserve PostgreSQL data
- Sequence: stop services → remove volumes → start fresh
- Named volume removal: `docker volume rm` for `postgres_data` and/or `clickhouse_data`
- Post-reset: start platform and print fresh-start message
- Unit tests: confirmation logic, flag validation (--yes alone rejected), volume selection (--keep-config)

### Step 9 — `yavio doctor`

- Node.js version check (>= 20 required)
- Docker availability and version
- `docker compose` (v2) availability and version
- `.yaviorc.json` found and valid (API key format, endpoint URL)
- Ingestion API reachable (`GET /health`)
- API key valid (if platform running: `POST /v1/events` with empty batch → check auth response)
- ClickHouse accepting writes (via ingest health readiness)
- Port conflict detection: check if 3000, 3001, 5432, 8123 are in use by non-Yavio processes
- TLS warning: if endpoint is non-localhost and uses HTTP, warn about security
- SDK version check: detect `@yavio/sdk` in nearest `node_modules`, compare with CLI version
- Each check: pass/fail/warn with clear description
- Unit tests: individual check logic (mocked), output formatting

### Step 10 — `yavio telemetry`

- `yavio telemetry status`: show enabled/disabled state and anonymous instance ID
- `yavio telemetry disable`: set `telemetry: false` in config
- `yavio telemetry enable`: set `telemetry: true` in config
- Telemetry config stored in `~/.yavio/config.json` (global, not per-project)
- Respects `YAVIO_TELEMETRY=false` env var (env takes precedence)
- Unit tests: config read/write, env var override

### Step 11 — Docker Compose Production Overrides

- Create `docker-compose.prod.yml` with production-ready overrides:
  - Resource limits: CPU and memory per service (sensible defaults)
  - Restart policies: `unless-stopped` (already in base, verify)
  - Log drivers: JSON file with rotation (`max-size: 10m`, `max-file: 3`)
  - Health check tuning: tighter intervals for production
  - Security: read-only root filesystem where possible, no new privileges
- Traefik/Nginx reverse proxy example in `config/` directory (commented YAML or separate guide)
- Usage: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`
- `yavio up --prod` flag: auto-includes production override file

### Step 12 — CI Integration

- Add `test-cli` job to `.github/workflows/ci.yml`:
  - Runs on `needs.detect.outputs.cli == 'true'`
  - `pnpm --filter @yavio/cli test`
- Verify `cli` change detection path already exists in `dorny/paths-filter` config
- Verify `@yavio/cli` builds in the monorepo `build` job
- Add `@yavio/cli` to `typecheck` step sequence (after shared/db, before dashboard)

### Step 13 — Tests

- Unit tests per command: init, up, down, status, logs, update, reset, doctor, telemetry
- Unit tests per utility: config, docker, http, output
- All external calls (Docker, HTTP, filesystem) mocked in unit tests
- Target: full coverage of command logic and edge cases
- **Milestone:** `yavio up` starts the full platform from local Docker images. `yavio init` creates valid SDK config. `yavio doctor` diagnoses common setup issues. `yavio status` shows live platform health. All CLI tests pass in CI.
