# Dashboard Testing

## Test Categories

| Category | Framework | Scope | Priority |
|----------|-----------|-------|----------|
| Auth tests | Vitest + Testing Library | Login, register, OAuth flow, invite acceptance, session management, role checks, account deletion | P0 — ship blocker |
| Workspace tests | Vitest + supertest | Workspace CRUD, member management, invitation flow, role-based access | P0 — ship blocker |
| API route tests | Vitest + supertest | Analytics query routes return correct data, scoped to project, respecting permissions, rate limiting | P1 — important |
| Component tests | Vitest + Testing Library | Dashboard views render correctly with mock ClickHouse data, premium feature cards with mock intelligence client | P1 — important |
| E2E tests | Playwright | Full user journeys: register → create workspace → create project → get API key → view dashboard | P1 — important |
| Performance tests | Vitest + custom benchmarks | ClickHouse query latency, dashboard page load times, SSE feed throughput | P1 — important |

## Key Test Scenarios

- **Auth security:** Unauthenticated users cannot access dashboard routes. Session cookies are httpOnly and secure. Password reset tokens expire. Account deletion removes all user data.
- **Workspace isolation:** User A cannot see User B's workspace. Analytics queries are always scoped to the current project and workspace. API routes enforce ownership.
- **Role enforcement:** Viewers cannot export data or manage settings. Members cannot invite or remove users. Admins have full access.
- **Invitation flow:** Invite email contains valid link. Clicking link with existing account joins workspace. Clicking link without account prompts registration then joins.
- **Analytics accuracy:** Dashboard metrics match expected values for known test datasets. Time range filters produce correct results. Platform filters work correctly.
- **User analytics:** Retention cohort matrix correctly computes return rates. DAU/WAU/MAU counts match expected unique `user_id` counts. User detail view shows complete event timeline. Sessions without `.identify()` appear as anonymous.
- **Path analysis:** Path visualization correctly sequences tool calls within sessions. Starting/ending point filters produce correct paths.
- **Rate limiting:** API routes return `429 Too Many Requests` when limits are exceeded. Rate limit headers are present. SSE connection limits are enforced.
- **Data deletion:** Workspace deletion removes all PostgreSQL rows and ClickHouse events. Project deletion removes project-scoped ClickHouse data. Account deletion cascades correctly.
- **Pagination:** Paginated routes respect `page`, `pageSize`, `sort`, `order` parameters. Edge cases: empty results, last page, invalid page numbers.

## Test Data & Fixtures

### Seed Strategy

- **PostgreSQL fixtures:** Vitest `beforeAll` hooks insert test users, workspaces, projects, and API keys via Drizzle ORM. Cleaned up in `afterAll`. Use a dedicated test database (`POSTGRES_DB=yavio_test`).
- **ClickHouse fixtures:** A seed script (`scripts/seed-clickhouse-test.ts`) inserts known event datasets into a test ClickHouse database. The dataset includes:
  - 10,000 `tool_call` events across 5 tools with known latency distributions
  - 500 `conversion` events with known revenue values
  - 200 `error` events across known error categories
  - 50 identified users with known session patterns for retention testing
  - 100 sessions with known tool call sequences for path testing
- **Fixture files:** Static JSON fixtures in `tests/fixtures/` for component tests that don't need a live database.

### Mocking Strategy

| Dependency | Unit/Component Tests | Integration Tests | E2E Tests |
|------------|---------------------|-------------------|-----------|
| ClickHouse | Mocked (`vi.mock`) — return fixture data | Real test database with seeded data | Real test database with seeded data |
| PostgreSQL | Mocked for component tests, real for API route tests | Real test database | Real test database |
| Intelligence service | Mocked — return `null` (unavailable) or fixture data (available) | Mocked HTTP server (`msw`) | Not tested (premium feature) |
| Stripe | Mocked (`vi.mock`) | Mocked webhook payloads via supertest | Not tested |
| NextAuth session | Mocked via test helper (`createMockSession(role)`) | Real session via test login | Real browser login |

## Performance Tests

### Dashboard Query Benchmarks

Measure ClickHouse query latency for each analytics route against the seeded test dataset. Run as part of CI on every PR.

| Route | Target p50 | Target p95 | Dataset Size |
|-------|-----------|-----------|-------------|
| `/analytics/[projectId]/overview` | < 100ms | < 300ms | 100K events |
| `/analytics/[projectId]/tools` | < 100ms | < 300ms | 100K events |
| `/analytics/[projectId]/users/retention` | < 200ms | < 500ms | 100K events, 1K users |
| `/analytics/[projectId]/paths` | < 300ms | < 800ms | 100K events |
| `/analytics/[projectId]/errors` | < 100ms | < 300ms | 100K events |
| `/analytics/[projectId]/live` (SSE poll) | < 50ms | < 150ms | 100K events |

### Page Load Benchmarks

Measure server-side rendering time for dashboard pages (Time to First Byte). Run via Playwright with performance tracing enabled.

| Page | Target TTFB |
|------|------------|
| Overview | < 500ms |
| Tool Explorer | < 500ms |
| Users (with retention matrix) | < 800ms |
| Live Feed (initial load) | < 300ms |

### Load Testing

Simulate concurrent dashboard users querying analytics routes. Not part of CI — run manually before releases.

| Scenario | Concurrent Users | Duration | Pass Criteria |
|----------|-----------------|----------|--------------|
| Normal load | 20 users | 5 minutes | p95 < 500ms, 0 errors |
| Peak load | 50 users | 5 minutes | p95 < 1s, error rate < 1% |
| SSE sustained | 30 SSE connections | 10 minutes | No disconnects, memory stable |

## Coverage Targets

| Category | Line Coverage | Branch Coverage |
|----------|-------------|----------------|
| Auth (lib/auth/) | 90% | 85% |
| API routes (app/api/) | 85% | 80% |
| Query builders (lib/queries/) | 90% | 85% |
| Components (app/(dashboard)/) | 75% | 70% |
| Overall | 80% | 75% |

## CI Integration

- **On every PR:** Unit tests, component tests, API route tests, performance benchmarks (query latency). Must all pass to merge.
- **On merge to main:** Full E2E suite (Playwright). Failures block release but not merge.
- **Weekly:** Load tests against staging environment. Results posted to team channel.
