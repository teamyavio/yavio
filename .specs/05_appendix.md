# 12. Appendix

## 12.1 Dependencies

### 12.1.1 SDK (`@yavio/sdk`)

| Package | Purpose | Why This One |
|---------|---------|-------------|
| nanoid | ID generation (traceId, sessionId) | Tiny, fast, URL-safe. No crypto overhead for non-security IDs. Format: `traceId` = `"tr_" + nanoid(21)`, `sessionId` = `"ses_" + nanoid(21)` (or adopted from `Mcp-Session-Id` on Streamable HTTP). Widget events share the server's `session_id` — no separate widget session ID is generated. See [server-sdk.md Section 3.7](./sdk/server-sdk.md#37-session-lifecycle). |
| tsup | Build/bundle | Zero-config TypeScript bundler. Dual CJS/ESM. Tree-shaking. |
| vitest | Testing | Fast, native TS, good ESM support. Compatible with Jest API. |
| biome | Lint + format | Single tool replaces ESLint + Prettier. Much faster. |

> **Note:** The SDK has zero native dependencies. `better-sqlite3` has been removed — the SDK uses `fetch` (built into Node 20+) for HTTP transport. This simplifies installation and eliminates native build issues.

### 12.1.2 Ingestion API (`yavio/ingest`)

| Package | Purpose | Why This One |
|---------|---------|-------------|
| fastify (or hono) | HTTP framework | Fastest Node.js HTTP framework. Built-in schema validation. |
| @clickhouse/client | ClickHouse client | Official Node.js client. Streaming inserts. Connection pooling. |
| pg / postgres.js | PostgreSQL client (for API key cache) | Lightweight PostgreSQL driver for key lookups. |
| nanoid | ID generation | Same as SDK. |

### 12.1.3 Dashboard (`yavio/dashboard`)

| Package | Purpose | Why This One |
|---------|---------|-------------|
| next | Web framework | Next.js 15 (App Router). Server Components for direct DB queries. |
| next-auth | Authentication | NextAuth.js v5. Industry-standard auth for Next.js. OAuth + credentials. Built-in Drizzle adapter for PostgreSQL sessions. |
| drizzle-orm | PostgreSQL ORM | Type-safe, lightweight, excellent DX. Migrations included. |
| @clickhouse/client | ClickHouse queries | Same client as ingestion API. |
| recharts (or tremor) | Charts | React-native charting. Good for analytics dashboards. |
| tailwindcss | Styling | Utility-first CSS. Industry standard. |
| shadcn/ui | UI components | Accessible, composable components. Not a dependency — copied into project. |
| zod | Validation | Schema validation for API routes and forms. |
| nodemailer | Email transport | SMTP-based email sending. Industry standard for Node.js. Configured via env vars (`SMTP_HOST`, etc.). See [dashboard/architecture.md §7.11](./dashboard/architecture.md#711-email-sending). |
| @react-email/components | Email templates | React components for email HTML. Templates rendered to HTML via `@react-email/render`. |

### 12.1.5 Observability (All Services)

| Package | Purpose | Why This One |
|---------|---------|-------------|
| pino | Structured JSON logging | Fastest Node.js logger. Native Fastify integration. Zero-config. |
| prom-client | Prometheus metrics exposition | Official Prometheus client for Node.js. Industry standard. |
| @sentry/node | Error tracking (ingest) | Industry standard. No-op when DSN is unset. |
| @sentry/nextjs | Error tracking (dashboard) | Official Next.js integration. SSR + client-side. Source maps. |
| @opentelemetry/sdk-node | Distributed tracing (Cloud) | Official OTel SDK. No-op when exporter is unconfigured. |
| @opentelemetry/exporter-trace-otlp-http | OTLP trace export (Cloud) | Standard OTLP exporter. Works with any OTLP-compatible backend. |

See [infrastructure/observability.md](./infrastructure/observability.md) for full details.

### 12.1.6 Infrastructure

| Component | Version | Purpose |
|-----------|---------|---------|
| Docker | v24+ | Container runtime |
| docker-compose | v2.20+ | Service orchestration |
| PostgreSQL | 16 | Application data storage |
| ClickHouse | 24.3+ | Analytics event storage |
| Node.js | 20+ LTS | Runtime for all Node services |

## 12.2 Performance Targets

### 12.2.1 SDK

| Metric | Target | Measurement |
|--------|--------|-------------|
| Proxy overhead per tool call | < 1ms | `performance.now()` delta: proxied vs. unproxied handler |
| Memory footprint (SDK only) | < 10 MB baseline | Heap snapshot with empty queue |
| Event serialization | < 0.1ms per event | Benchmark event → JSON serialization |
| PII redaction (per event) | < 0.5ms | Regex-based best-effort scrub before queue |
| HTTP flush (100 events) | < 50ms | Round-trip to local ingestion API |

### 12.2.2 Ingestion API

| Metric | Target | Measurement |
|--------|--------|-------------|
| Throughput | 10,000 events/second (single instance) | Load test with concurrent SDKs |
| API key validation (cached) | < 0.1ms | In-memory cache hit |
| API key validation (miss) | < 5ms | PostgreSQL query |
| PII stripping (per event) | < 1ms | Benchmark with realistic event payloads |
| ClickHouse batch write (1,000 events) | < 50ms | `INSERT ... FORMAT JSONEachRow` benchmark |
| End-to-end latency (event received → ClickHouse) | < 2 seconds | Timer from HTTP receipt to ClickHouse `SELECT` confirmation |

### 12.2.3 Dashboard

| Metric | Target | Measurement |
|--------|--------|-------------|
| Overview page load (7-day, 100K events) | < 500ms | ClickHouse aggregation queries |
| Tool Explorer query | < 200ms | Per-tool filtered query |
| Live Feed SSE latency | < 3 seconds | Time from event ingestion to SSE push |
| Auth page load (SSR) | < 200ms | Server-side rendered login/register |
| Dashboard page navigation (client) | < 100ms | React Router transition |

### 12.2.5 Infrastructure

| Metric | Target | Measurement |
|--------|--------|-------------|
| Cold start (docker-compose up) | < 60 seconds | Time from `up` to all health checks passing |
| ClickHouse disk usage per 1M events | < 200 MB | ClickHouse compression (LZ4, column-oriented) |
| PostgreSQL size (1000 users, 100 workspaces) | < 50 MB | Minimal app data footprint |

