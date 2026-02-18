# Infrastructure Testing

## Test Categories

| Category | Framework | Scope | Priority |
|----------|-----------|-------|----------|
| Docker tests | docker-compose + shell scripts | All services start, health checks pass, services communicate | P0 |
| Migration tests | Custom scripts | ClickHouse and PostgreSQL migrations run cleanly on fresh and existing databases | P0 |
| Integration tests | Vitest + Testcontainers | SDK → ingest → ClickHouse → dashboard query — full data path | P0 |
| Security tests | Vitest + custom scripts | PII redaction, auth bypass, workspace isolation, JWT validation | P0 |
| Load tests | k6 | Ingestion throughput, ClickHouse query latency under load | P1 |
| Performance tests | Playwright + Lighthouse CI | Dashboard page load times, Time to Interactive | P2 |

## Docker Tests

Validates that the platform starts correctly from a clean state.

### Startup & Health

| Test | Assertion | Timeout |
|------|-----------|---------|
| `docker-compose up` from scratch | All services healthy (`docker-compose ps` shows no unhealthy) | 60s |
| ClickHouse readiness | `SELECT 1` succeeds on port 8123 | 15s |
| PostgreSQL readiness | `pg_isready -U yavio` succeeds | 10s |
| Ingest API readiness | `GET /health` returns 200 | 20s |
| Dashboard readiness | `GET /api/health` returns 200 | 30s |
| Service restart recovery | Kill ClickHouse → ingest health check fails → ClickHouse restarts → ingest recovers | 30s |

### Network Isolation

| Test | Assertion |
|------|-----------|
| Database ports not exposed | `curl localhost:5432` and `curl localhost:8123` fail from host |
| Ingest can reach ClickHouse | Ingest `GET /health` includes `clickhouse: ok` |
| Dashboard can reach both DBs | Dashboard `GET /api/health` includes `clickhouse: ok`, `postgres: ok` |
| Cross-service DNS | `ingest` container can resolve `clickhouse` and `postgres` hostnames |

### Env Var Validation

| Test | Assertion |
|------|-----------|
| Missing `NEXTAUTH_SECRET` | `docker-compose up` refuses to start (compose `?` syntax error) |
| Default `POSTGRES_PASSWORD` | Services start with `yavio_dev` default in dev mode |
| Custom `YAVIO_RETENTION_DAYS` | ClickHouse TTL reflects configured value |

## Migration Tests

### PostgreSQL

| Test | Assertion |
|------|-----------|
| Fresh migration | All tables created, indexes exist, constraints valid |
| Idempotent re-run | Running migrations twice produces no errors |
| Rollback | Down migration removes tables cleanly |
| Seed data | Test seed script inserts user, workspace, project, API key without constraint violations |

### ClickHouse

| Test | Assertion |
|------|-----------|
| Fresh migration | `events` table, all materialized views, `tool_registry`, and premium tables created |
| Idempotent re-run | Re-running migration scripts produces no errors |
| Schema validation | Column types match spec (JSON fields are `JSON`, LowCardinality applied, etc.) |
| ORDER BY correctness | `events` table ordered by `(workspace_id, project_id, event_type, timestamp)` |
| TTL configured | `SHOW CREATE TABLE events` includes TTL clause matching `YAVIO_RETENTION_DAYS` |

## Integration Tests (End-to-End Data Path)

Run against real Docker services using Testcontainers or a shared `docker-compose.test.yml`.

### Full Pipeline

| Test | Steps | Assertion |
|------|-------|-----------|
| Server SDK → ClickHouse | `withYavio()` wraps tool → tool called → SDK flushes → query ClickHouse | Event row exists with correct `project_id`, `event_type=tool_call`, `trace_id` |
| Widget → ClickHouse | Mint widget JWT → POST widget event to ingest → query ClickHouse | Widget event exists, `source=widget`, `trace_id` matches JWT |
| Trace correlation | Server tool call + widget events share `trace_id` → query by trace | Both server and widget events returned, ordered by timestamp |
| Identify propagation | `ctx.yavio.identify(userId, traits)` → subsequent events | All events after identify carry `user_id`, `user_traits` populated |
| Conversion tracking | `ctx.yavio.conversion("purchase", { value: 29.99, currency: "USD" })` | Event has `conversion_value=29.99`, `conversion_currency=USD` |
| Materialized views | Insert events → wait for MV refresh → query `sessions_mv` and `users_mv` | Aggregated rows match expected counts and sums |

### Dashboard Query Accuracy

| Test | Steps | Assertion |
|------|-------|-----------|
| Overview metrics | Seed 100 events → `GET /api/analytics/:projectId/overview` | `totalEvents=100`, `uniqueSessions` and `uniqueUsers` match seed data |
| Tool breakdown | Seed events for 3 tools → `GET /api/analytics/:projectId/tools` | Each tool appears with correct invocation count and avg latency |
| Funnel query | Seed stepped session → `GET /api/analytics/:projectId/funnels` | Step completion rates match seed |
| Time filtering | Seed events across 30 days → query with `from`/`to` | Only events within window returned |
| Platform filtering | Seed events for chatgpt + claude → filter `?platform=chatgpt` | Only ChatGPT events returned |

## Security Tests

### PII Redaction

| Test | Input | Expected Output |
|------|-------|-----------------|
| Email in metadata | `{ "email": "john@example.com" }` | `{ "email": "[EMAIL_REDACTED]" }` |
| Credit card in error message | `"Card 4111111111111111 declined"` | `"Card [CC_REDACTED] declined"` |
| SSN in traits | `{ "ssn": "123-45-6789" }` | `{ "ssn": "[SSN_REDACTED]" }` |
| Phone in nested JSON | `{ "contact": { "phone": "+1-555-123-4567" } }` | `{ "contact": { "phone": "[PHONE_REDACTED]" } }` |
| Clean data unchanged | `{ "tool": "search", "query": "flights" }` | Identical — no false positives |
| Bulk redaction | Batch of 100 events with mixed PII | All PII patterns redacted, non-PII preserved |

### Authentication & Authorization

| Test | Assertion |
|------|-----------|
| Invalid API key | `POST /v1/events` with `Authorization: Bearer invalid` returns 401 |
| Revoked API key | Revoke key in PostgreSQL → next request returns 401 |
| Expired widget JWT | JWT with past `exp` claim returns 401 |
| JWT trace mismatch | Widget event `trace_id` differs from JWT `tid` claim → rejected |
| Missing auth header | `POST /v1/events` with no `Authorization` header returns 401 |
| Dashboard without session | `GET /api/analytics/:projectId/overview` without cookie returns 401 |
| Role enforcement: Viewer | Viewer role cannot access settings, export, or API key endpoints |
| Role enforcement: Member | Member cannot invite/remove members or create/delete projects |

### Workspace Isolation

| Test | Assertion |
|------|-----------|
| Cross-workspace query | User in workspace A queries analytics for workspace B project → 403 |
| API key scoping | API key for project A cannot write events to project B |
| Member boundary | Non-member of workspace cannot access any workspace endpoints |
| Admin of workspace A | Cannot see members or projects of workspace B |

## Load Tests (k6)

### Ingestion Throughput

```
Target: Sustain 1,000 events/sec per API key for 5 minutes
```

| Scenario | VUs | Duration | Pass Criteria |
|----------|-----|----------|---------------|
| Steady state | 50 VUs, 20 events/batch | 5 min | p99 latency < 500ms, 0 errors |
| Burst | 200 VUs, 50 events/batch, ramp over 30s | 2 min | p99 < 2s, error rate < 1% |
| Rate limit verification | 100 VUs exceeding 1,000 events/sec | 1 min | 429 responses returned, no 5xx |
| Backpressure | ClickHouse writes artificially slowed | 3 min | Ingest returns 503, no data loss after recovery |

### ClickHouse Query Latency

```
Target: Dashboard queries return in < 2s for projects with up to 10M events
```

| Query | Dataset | Pass Criteria |
|-------|---------|---------------|
| Overview (24h aggregation) | 10M events, 30 days | < 500ms |
| Tool breakdown (7d, top 20) | 10M events | < 1s |
| Funnel (3-step, 7d) | 1M sessions | < 2s |
| User retention cohort (30d) | 500K users | < 2s |
| Live feed (last 50 events) | 10M events | < 200ms |

### Dashboard Page Load

| Page | Pass Criteria |
|------|---------------|
| Login | LCP < 1.5s |
| Overview dashboard | LCP < 3s (including chart render) |
| Tool explorer | LCP < 2.5s |
| User list | LCP < 2s |

## Test Data Seeding

A shared seeding utility (`packages/shared/test-seed.ts`) generates deterministic test data for all test levels.

### Seed Profiles

| Profile | Events | Sessions | Users | Tools | Duration |
|---------|--------|----------|-------|-------|----------|
| `minimal` | 50 | 5 | 3 | 2 | 1 day |
| `standard` | 5,000 | 200 | 50 | 10 | 30 days |
| `load` | 1,000,000 | 50,000 | 10,000 | 25 | 90 days |
| `pii` | 500 | 50 | 20 | 5 | 7 days (all events contain PII patterns) |

Each profile generates:
- Events distributed across `tool_call`, `step`, `track`, `conversion`, `identify`, `connection`, and widget event types
- Realistic platform distribution (40% ChatGPT, 30% Claude, 20% Cursor, 10% VS Code)
- Traces linking server and widget events via shared `trace_id`
- Users with `.identify()` calls and traits
- Error events with varied `error_category` values
- Conversions with realistic `conversion_value` and `conversion_currency`

### Seed CLI

```bash
# Seed local development environment
yavio seed --profile standard

# Seed for load testing
yavio seed --profile load --clickhouse-url http://localhost:8123
```

## CI/CD Pipeline

### Pipeline Stages

```
┌─────────┐    ┌──────────┐    ┌─────────────┐    ┌──────────┐    ┌────────┐
│  Lint   │───▶│  Build   │───▶│  Unit Test  │───▶│  Docker  │───▶│ Deploy │
│         │    │          │    │             │    │  Test    │    │        │
└─────────┘    └──────────┘    └─────────────┘    └──────────┘    └────────┘
                                                       │
                                                  ┌────▼─────┐
                                                  │Integration│
                                                  │   Test    │
                                                  └──────────┘
```

### Stage Details

| Stage | Runner | Trigger | Timeout |
|-------|--------|---------|---------|
| **Lint** | Node.js 22 | Every push | 2 min |
| **Build** | Node.js 22 | Every push | 5 min |
| **Unit Tests** | Node.js 22 | Every push | 5 min |
| **Docker Tests** | Docker-in-Docker | Every push to `main`, all PRs | 10 min |
| **Integration Tests** | Docker-in-Docker | PRs targeting `main` | 15 min |
| **Load Tests** | Dedicated runner (k6) | Weekly schedule + manual trigger | 30 min |
| **Security Tests** | Node.js 22 + Docker | Every push to `main`, all PRs | 10 min |
| **Deploy (Staging)** | Docker push + deploy | Merge to `main` | 10 min |
| **Deploy (Production)** | Docker push + deploy | Manual approval after staging | 10 min |

### PR Checks (Required to Merge)

- All lint passes (ESLint, Prettier, TypeScript strict)
- All unit tests pass
- All Docker tests pass (services start, health checks green)
- All integration tests pass (data path verified)
- All security tests pass (PII, auth, isolation)
- No `POSTGRES_PASSWORD`, `NEXTAUTH_SECRET`, or API keys in committed files

### Branch Strategy

| Branch | Purpose | Deploy Target |
|--------|---------|---------------|
| `main` | Stable, tested | Staging (auto), Production (manual) |
| `feat/*` | Feature development | PR preview (optional) |
| `fix/*` | Bug fixes | PR preview (optional) |
| `release/*` | Release candidates | Production (after QA sign-off) |
