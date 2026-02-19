# Dashboard Roadmap

## Phase 4: Auth & Workspace Management

- Next.js 16 project setup (App Router)
- NextAuth.js v5 integration
- Auth pages: login, register, forgot password, email verification
- OAuth providers: GitHub, Google
- PostgreSQL ORM setup (Drizzle)
- Workspace CRUD: create, rename, delete, plan management
- Member management: invite, accept, remove, change role
- Project CRUD: create, rename, delete (including ClickHouse data cleanup)
- API key management: create, list, revoke, rotate
- User account deletion endpoint
- Role-based middleware: admin/member/viewer permission checks
- Rate limiting middleware (all API routes)
- Invitation email flow (or link-based for v1)
- Auth tests: all flows
- Workspace isolation tests
- **Milestone:** User can register, create workspace, create project, generate API key, invite teammate

## Phase 5: Dashboard Analytics Views

- ClickHouse query client setup in Next.js
- Analytics query builders (project-scoped, time-filtered, paginated)
- Overview page: KPIs, time-series charts, platform breakdown, DAU/WAU/MAU
- Tool Explorer page: per-tool metrics, latency distribution, error breakdown
- Funnel View page: step progression, drop-off rates, example traces
- Users page: user list, retention cohort matrix, DAU/WAU/MAU charts, stickiness, new vs returning, user detail timeline
- Paths page: Sankey path visualization (@nivo/sankey), starting/ending point filters, drop-off paths
- Live Feed page: SSE endpoint, real-time event stream, expand/collapse
- Errors page: error rate trends, category breakdown, per-tool errors
- Project selector in sidebar
- Workspace switcher
- Chart components (Recharts 3.x via shadcn/ui chart components)
- "Available with Cloud Pro" placeholder cards
- Component tests for all views
- Performance tests: ClickHouse query benchmarks
- **Milestone:** Full dashboard with all 7 views showing real data from ClickHouse

## Phase 8: Polish & Ship — Dashboard Items

- Dark mode implementation: full token system (light/dark), theme switcher in user settings, `localStorage` persistence, `prefers-color-scheme` fallback
- Onboarding flow in dashboard (create project → show snippet → wait for first event)
- Docker image publish `yavio/dashboard`
- E2E Playwright tests for critical paths
- Performance benchmarking (dashboard query speed, page load TTFB)
- Load testing (concurrent users, SSE sustained connections)
- Security review: auth flows, API key handling, CORS, rate limiting
- **Milestone:** Dark mode complete, all performance targets met, security review passed

## Future Versions

- Caching layer: `Cache-Control` headers for analytics routes, ISR for server components, query result caching (Redis or in-memory)
- Data export: CSV download for tables (tool list, user list, error list), scheduled report emails
- Live Feed SSE scalability: replace per-connection ClickHouse polling with Redis pub/sub (or similar) between ingestion API and SSE endpoint; add client-side event list cap / virtual scrolling; add BroadcastChannel for cross-tab connection sharing; add server-side backpressure / sampling for high-volume projects
