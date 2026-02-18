# Monitoring & Observability

The Yavio platform captures rich analytics data for its users — but the platform itself also needs monitoring. This spec covers how we observe the health, performance, and correctness of Yavio's own services: the ingestion API, dashboard, intelligence service, ClickHouse, and PostgreSQL.

**Design principle:** Yavio is an analytics product that developers self-host with `docker-compose up`. The observability stack must not add operational complexity for self-hosters. Expose standard, vendor-neutral interfaces (`/metrics`, structured stdout logs, OTLP traces) and let users bring their own monitoring tools if they want dashboards and alerting. On Yavio Cloud, the observability backend is a deployment-time choice — the platform works with any combination of Google Cloud, Grafana Cloud, AWS, or Datadog (see [§6.2](#62-compatible-backends)).

## 1. Structured Logging

All services log structured JSON to stdout/stderr. Docker captures these logs natively. Self-hosters access logs via `yavio logs` (wraps `docker-compose logs`) or their own log aggregation.

### 1.1 Library

| Service | Library | Rationale |
|---------|---------|-----------|
| `yavio-ingest` | pino | Fastify's built-in logger. Fastest Node.js JSON logger. Zero-config integration. |
| `yavio-dashboard` | pino | `next-logger` or `pino-http` middleware. Consistent format across services. |
| `yavio-intelligence` | pino | Same as ingest. Consistent format. |

> **Why Pino?** Fastify uses Pino internally — the ingestion API gets structured logging for free. Using the same library across all services ensures a consistent log schema without extra dependencies. Pino is 5-10x faster than Winston and outputs JSON natively.

### 1.2 Log Format

Every log line is a single JSON object:

```json
{
  "level": 30,
  "time": 1710496200000,
  "service": "ingest",
  "requestId": "req_a1b2c3",
  "msg": "batch written to ClickHouse",
  "eventCount": 48,
  "durationMs": 12
}
```

### 1.3 Standard Fields

| Field | Type | Description |
|-------|------|-------------|
| `level` | number | Pino log level: 10=trace, 20=debug, 30=info, 40=warn, 50=error, 60=fatal |
| `time` | number | Unix timestamp in milliseconds |
| `service` | string | Service name: `ingest`, `dashboard`, `intelligence` |
| `requestId` | string | Unique per-request ID. Generated at request entry, propagated via `AsyncLocalStorage`. |
| `msg` | string | Human-readable log message |
| `err` | object | Error object with `message`, `stack`, `code` (only on error/fatal levels) |

Additional context fields are added per log call (e.g., `eventCount`, `durationMs`, `projectId`). No fixed schema — structured but flexible.

### 1.4 Request Correlation

Each inbound HTTP request receives a `requestId` (generated via `nanoid` or `crypto.randomUUID()`). The ID is:

1. Stored in `AsyncLocalStorage` at request entry (same mechanism used for `traceId` in the SDK — see [server-sdk.md §3.5](../sdk/server-sdk.md#35-trace-id--combined-funnel))
2. Attached to every log line within that request's lifecycle
3. Returned in the response as `X-Request-Id` header
4. Passed to downstream service calls (dashboard → ingest, dashboard → intelligence) in the `X-Request-Id` header

This allows correlating logs across services for a single user action without a full distributed tracing setup.

### 1.5 Log Levels by Environment

| Environment | Default Level | Configurable |
|-------------|---------------|-------------|
| Development | `debug` (20) | `LOG_LEVEL` env var |
| Production (self-hosted) | `info` (30) | `LOG_LEVEL` env var |
| Production (Cloud) | `info` (30) | Per-service config |

### 1.6 Sensitive Data

Logs must never contain:

- API keys or JWT tokens (log the `key_prefix` only, e.g., `yav_proj_a1b2...`)
- User passwords or OAuth tokens
- PII from event payloads (events are PII-stripped before logging)
- Full request bodies (log `eventCount` and `batchSizeBytes` instead)

### 1.7 Environment Variable

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LOG_LEVEL` | No | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |

## 2. Metrics

Each service exposes a Prometheus-compatible `GET /metrics` endpoint. Self-hosters can scrape these with their own Prometheus instance if they want dashboards and alerting. On Yavio Cloud, Grafana Mimir scrapes all services.

### 2.1 Library

| Package | Purpose | Why This One |
|---------|---------|-------------|
| prom-client | Prometheus metrics | De facto standard for Node.js. Official Prometheus client. Histogram, counter, gauge, summary support. Default Node.js process metrics. |

### 2.2 Default Process Metrics

`prom-client` exposes Node.js runtime metrics out of the box (enabled via `collectDefaultMetrics()`):

- `process_cpu_seconds_total` — CPU usage
- `nodejs_heap_size_total_bytes` — Heap memory
- `nodejs_active_handles_total` — Active handles (connections, timers)
- `nodejs_eventloop_lag_seconds` — Event loop lag

These are exposed on all three services with no additional code.

### 2.3 Ingestion API Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `yavio_ingest_events_received_total` | counter | `source` (server, widget) | Total events received via HTTP |
| `yavio_ingest_events_written_total` | counter | `source` | Total events successfully written to ClickHouse |
| `yavio_ingest_events_rejected_total` | counter | `reason` (validation, auth, rate_limit) | Total events rejected |
| `yavio_ingest_batch_write_duration_seconds` | histogram | — | ClickHouse batch write latency |
| `yavio_ingest_batch_size` | histogram | — | Number of events per ClickHouse batch insert |
| `yavio_ingest_pii_strip_duration_seconds` | histogram | — | PII stripping latency per batch |
| `yavio_ingest_api_key_cache_hits_total` | counter | — | API key cache hits |
| `yavio_ingest_api_key_cache_misses_total` | counter | — | API key cache misses (PostgreSQL lookup) |
| `yavio_ingest_http_request_duration_seconds` | histogram | `method`, `route`, `status` | HTTP request latency |
| `yavio_ingest_backpressure_active` | gauge | — | 1 when write buffer exceeds threshold, 0 otherwise |
| `yavio_ingest_dead_letter_count` | gauge | — | Number of events in dead-letter queue (post-v1, see [event-pipeline.md §6.6](../ingest/event-pipeline.md#66-future-dead-letter-queue)) |

### 2.4 Dashboard Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `yavio_dashboard_http_request_duration_seconds` | histogram | `method`, `route`, `status` | HTTP request latency (API routes + page loads) |
| `yavio_dashboard_clickhouse_query_duration_seconds` | histogram | `query_type` (overview, tools, funnels, users, live) | ClickHouse query latency by view |
| `yavio_dashboard_active_sessions` | gauge | — | Current authenticated user sessions |
| `yavio_dashboard_sse_connections` | gauge | — | Active Server-Sent Events connections (Live Feed) |
| `yavio_dashboard_auth_failures_total` | counter | `reason` (invalid_credentials, expired_session, oauth_error) | Authentication failures |

### 2.6 Histogram Buckets

All duration histograms use Prometheus default buckets (`.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10` seconds) unless noted. The `batch_write_duration_seconds` histogram uses tighter buckets: `.001, .005, .01, .025, .05, .1, .25, .5, 1` to capture sub-100ms writes accurately.

### 2.7 Endpoint Security

The `/metrics` endpoint requires a bearer token when `METRICS_BEARER_TOKEN` is set. Prometheus supports bearer token authentication natively via `authorization` in `scrape_configs`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `METRICS_BEARER_TOKEN` | No | — | Bearer token for `/metrics` endpoint authentication. If set, requests without a valid `Authorization: Bearer <token>` header receive `401 Unauthorized`. If unset, the endpoint is open (for backward compatibility and local development). |

**Prometheus configuration:**

```yaml
scrape_configs:
  - job_name: yavio-ingest
    static_configs:
      - targets: ["ingest:3001"]
    authorization:
      credentials: "<METRICS_BEARER_TOKEN value>"
```

**Deployment guidance:**

- **Self-hosted (local):** Token not required. The endpoint is only accessible on the Docker network.
- **Self-hosted (production):** Set `METRICS_BEARER_TOKEN` if the service is exposed externally via reverse proxy. Alternatively, exclude `/metrics` from public routes at the reverse proxy level.
- **Cloud:** `METRICS_BEARER_TOKEN` is always set. The endpoint is only accessible within the private VPC. Grafana Mimir's scraper uses the token for authentication.

## 3. Health Checks

Health check endpoints are defined in the service specs and Docker Compose configuration. This section consolidates them for reference.

### 3.1 Endpoints

| Service | Endpoint | Interval | Timeout | Retries | Checks |
|---------|----------|----------|---------|---------|--------|
| `yavio-ingest` | `GET /health` | 10s | 5s | 3 | PostgreSQL connectivity, ClickHouse connectivity |
| `yavio-dashboard` | `GET /api/health` | 10s | 5s | 3 | PostgreSQL connectivity, ClickHouse connectivity |
| `clickhouse` | `clickhouse-client --query "SELECT 1"` | 5s | 5s | 5 | Process alive, can execute queries |
| `postgres` | `pg_isready -U yavio` | 5s | 5s | 5 | Process alive, accepting connections |

See [deployment.md §9.1](./deployment.md#91-self-hosted-deployment) for the full Docker Compose healthcheck configuration.

### 3.2 Response Format

All health endpoints return a consistent JSON shape:

```json
{
  "status": "healthy",
  "services": {
    "postgres": { "status": "healthy", "latencyMs": 2 },
    "clickhouse": { "status": "healthy", "latencyMs": 5 }
  },
  "version": "1.0.0",
  "uptime": 86400
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | `healthy` or `unhealthy` |
| `services` | object | Dependency health with latency for each |
| `version` | string | Service version (from `package.json`) |
| `uptime` | number | Seconds since process start |

HTTP status: `200` when healthy, `503` when any dependency is unhealthy.

## 4. Error Tracking

Sentry is integrated into the ingestion API and dashboard for catching uncaught exceptions and runtime errors. This is distinct from the analytics events the platform captures for users — Sentry monitors Yavio itself.

### 4.1 Integration

| Service | Package | Notes |
|---------|---------|-------|
| `yavio-ingest` | `@sentry/node` | Fastify plugin. Captures unhandled exceptions, rejected promises, and HTTP 5xx errors. |
| `yavio-dashboard` | `@sentry/nextjs` | Next.js integration. Captures server-side and client-side errors. Source maps uploaded at build time. |
| `yavio-intelligence` | `@sentry/node` | Same as ingest. |

### 4.2 Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SENTRY_DSN` | No | — | Sentry Data Source Name. If unset, Sentry is disabled (no-op). Self-hosters can point this at their own Sentry instance. |
| `SENTRY_ENVIRONMENT` | No | `production` | Environment tag: `development`, `staging`, `production` |
| `SENTRY_TRACES_SAMPLE_RATE` | No | `0.1` | Fraction of transactions to send to Sentry (performance monitoring). 10% default keeps costs low. |

> **Self-hosted users:** Sentry is entirely optional. If `SENTRY_DSN` is not set, the Sentry SDK initializes as a no-op with zero overhead. Users who want error tracking can set `SENTRY_DSN` to their own Sentry project (self-hosted Sentry or sentry.io).

### 4.3 What Gets Captured

| Category | Example | Captured |
|----------|---------|----------|
| Unhandled exceptions | `TypeError` in request handler | Yes — automatic |
| Unhandled promise rejections | Forgotten `await` on async function | Yes — automatic |
| HTTP 5xx responses | ClickHouse connection failure returning 503 | Yes — automatic via Fastify/Next.js integration |
| Expected errors (4xx) | Invalid API key (401), rate limited (429) | No — these are normal operations, not bugs |
| ClickHouse write failures | Batch insert timeout after retries | Yes — captured explicitly with context (batch size, retry count) |
| Background job failures | Clustering job crash | Yes — captured explicitly in job runner |

### 4.4 Sensitive Data Scrubbing

Sentry's `beforeSend` hook strips the same categories as the PII engine (see [event-pipeline.md §6.3](../ingest/event-pipeline.md#63-pii-stripping-engine)): emails, credit cards, SSNs, phone numbers. API keys and JWT tokens are never attached to Sentry events. Request bodies are excluded — only headers (sans `Authorization`) and URL are captured.

## 5. Distributed Tracing

OpenTelemetry (OTel) provides request-level traces across services. This is a **Cloud-only concern in v1** — self-hosters get request correlation via `requestId` in logs (§1.4), which covers most debugging scenarios. Full distributed tracing is added for Cloud to diagnose cross-service latency issues at scale.

### 5.1 Architecture

```
Ingest API ──┐
             ├──► OTLP Exporter ──► Any OTLP-compatible backend
Dashboard ───┤                       (Cloud Trace, Tempo, Jaeger, etc.)
             │
Intelligence ┘
```

### 5.2 Library

| Package | Purpose | Why This One |
|---------|---------|-------------|
| `@opentelemetry/sdk-node` | OTel SDK for Node.js | Official SDK. Auto-instrumentation for HTTP, `pg`, `@clickhouse/client`. |
| `@opentelemetry/exporter-trace-otlp-http` | OTLP exporter | Sends traces to any OTLP-compatible backend (Google Cloud Trace, Grafana Tempo, Jaeger, AWS X-Ray, Datadog). |

### 5.3 Auto-Instrumentation

OTel auto-instruments these libraries with no manual span creation:

| Library | What's Traced |
|---------|---------------|
| `http` / `undici` | Inbound and outbound HTTP requests with method, URL, status, duration |
| `pg` / `postgres.js` | PostgreSQL queries with query text (parameterized), duration |
| `@clickhouse/client` | ClickHouse operations with query text, duration, row count |

Manual spans are added for key business operations:

| Span | Service | Description |
|------|---------|-------------|
| `pii.strip` | ingest | PII stripping of an event batch |
| `batch.write` | ingest | ClickHouse batch insert (wraps the auto-instrumented query with business context) |
| `auth.resolve` | ingest | API key resolution (cache hit or PostgreSQL lookup) |
| `analytics.query` | dashboard | Dashboard analytics query (adds view name, time range, project) |
| `clustering.run` | intelligence | Full clustering job execution |
| `llm.call` | intelligence | LLM API call (adds provider, task type, token count) |

### 5.4 Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | — | OTLP endpoint URL. If unset, tracing is disabled (no-op). |
| `OTEL_SERVICE_NAME` | No | Auto-detected | Service name in traces. Defaults to `yavio-ingest`, `yavio-dashboard`, `yavio-intelligence`. |
| `OTEL_TRACES_SAMPLER` | No | `parentbased_traceidratio` | Sampling strategy |
| `OTEL_TRACES_SAMPLER_ARG` | No | `0.1` | Sample 10% of traces (Cloud). Adjust based on volume. |

> **Self-hosted users:** Distributed tracing is disabled by default (no `OTEL_EXPORTER_OTLP_ENDPOINT` set). Users who want it can point the OTLP exporter at their own Jaeger, Tempo, Zipkin, or cloud provider trace backend. The OTel SDK initializes as a no-op when no exporter is configured, adding zero overhead.

### 5.5 Trace ↔ Log Correlation

When tracing is enabled, the OTel `trace_id` and `span_id` are injected into Pino log lines automatically (via `@opentelemetry/instrumentation-pino`). This allows jumping from a log line directly to the corresponding trace in the trace backend (e.g., Cloud Trace, Tempo, Jaeger).

```json
{
  "level": 30,
  "time": 1710496200000,
  "service": "ingest",
  "requestId": "req_a1b2c3",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "msg": "batch written to ClickHouse"
}
```

## 6. Cloud Observability Stack

Yavio services export standard interfaces (structured JSON logs to stdout, Prometheus `/metrics`, OTLP traces). The choice of observability backend is a deployment decision, not an application concern. Any combination of the backends listed below works without service code changes.

### 6.1 Standard Interfaces

| Pillar | Interface | Protocol | Consumed By |
|--------|-----------|----------|-------------|
| Logs | Structured JSON to stdout/stderr | Container log driver | Any log aggregator (see §6.2) |
| Metrics | `GET /metrics` on each service | Prometheus exposition format | Any Prometheus-compatible scraper (see §6.2) |
| Traces | OTLP/HTTP export from OTel SDK | OpenTelemetry Protocol | Any OTLP-compatible backend (see §6.2) |
| Error tracking | Sentry SDK | Sentry protocol | Sentry (sentry.io or self-hosted) |

### 6.2 Compatible Backends

The table below lists proven backend options per pillar. Mix and match — e.g., Google Cloud for logs + metrics and Sentry for error tracking.

| Pillar | Google Cloud | Grafana Cloud | AWS | Datadog |
|--------|-------------|---------------|-----|---------|
| **Logs** | Cloud Logging (via Ops Agent or GKE auto-ingestion) | Loki (via Grafana Agent/Alloy) | CloudWatch Logs (via Fluent Bit / CloudWatch Agent) | Datadog Log Management (via Datadog Agent) |
| **Metrics** | Cloud Monitoring (via Managed Service for Prometheus) | Mimir (via Grafana Agent/Alloy scrape) | CloudWatch Metrics (via CloudWatch Agent) or Amazon Managed Prometheus | Datadog Metrics (via Datadog Agent) |
| **Traces** | Cloud Trace (native OTLP endpoint) | Tempo (OTLP endpoint) | X-Ray (via OTLP → X-Ray collector) | Datadog APM (OTLP endpoint) |
| **Dashboards** | Cloud Monitoring Dashboards | Grafana | CloudWatch Dashboards | Datadog Dashboards |
| **Alerting** | Cloud Monitoring Alerting Policies | Grafana Alerting | CloudWatch Alarms + SNS | Datadog Monitors |

> **No vendor lock-in:** Because every service writes logs to stdout (not a vendor SDK), exposes Prometheus metrics (not a vendor-specific format), and sends traces via OTLP (not a vendor-specific protocol), switching backends is a configuration change — swap the collection agent and exporter endpoint. No application code changes required.

### 6.3 Collection Agent

Each backend typically requires a collection agent running alongside the services to ship logs and scrape metrics. Traces are sent directly from the OTel SDK to the backend (no agent relay needed).

| Backend | Agent | Log Collection | Metrics Scraping |
|---------|-------|---------------|-----------------|
| Google Cloud | Ops Agent (or GKE built-in) | Tails container stdout, forwards to Cloud Logging | Scrapes `/metrics`, writes to Managed Prometheus |
| Grafana Cloud | Grafana Alloy (fka Grafana Agent) | Tails container stdout, pushes to Loki | Scrapes `/metrics`, remote-writes to Mimir |
| AWS | Fluent Bit / CloudWatch Agent | Tails container stdout, forwards to CloudWatch Logs | Scrapes `/metrics`, writes to CloudWatch or AMP |
| Datadog | Datadog Agent | Tails container stdout, forwards to Datadog Logs | Scrapes `/metrics`, writes to Datadog Metrics |

### 6.4 Key Dashboards (Cloud)

Regardless of the chosen backend, the operations team should have dashboards covering these metrics. The specific dashboard tooling (Grafana, Cloud Monitoring, CloudWatch, Datadog) depends on the backend selection.

#### Ingestion Health

- Events received/written/rejected rate (per second, 5-minute rolling)
- Batch write latency (p50, p95, p99)
- API key cache hit ratio
- Backpressure gauge (write buffer utilization)
- ClickHouse insert throughput
- Dead-letter queue depth (post-v1)

#### Dashboard Performance

- HTTP request latency by route (p50, p95, p99)
- ClickHouse query latency by view type
- Active SSE connections
- Auth failure rate
- Error rate (5xx / total)


#### Infrastructure

- Node.js heap and CPU per service
- Event loop lag per service
- ClickHouse: queries/s, rows inserted/s, merge operations, disk usage, parts count
- PostgreSQL: active connections, query duration, cache hit ratio, disk usage

### 6.5 Alerting Rules (Cloud)

These alert rules apply regardless of the alerting backend. Route P1/P2 to an on-call escalation tool (PagerDuty, Opsgenie, etc.) and P3 to a notification channel (Slack, email, etc.).

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| Ingestion down | Health check fails for > 1 minute | P1 | Page on-call |
| Ingestion error rate | > 5% of events rejected (5-min window) | P2 | Page on-call |
| ClickHouse write latency | p99 > 1s (5-min window) | P2 | Page on-call |
| Backpressure active | Write buffer > 80% for > 2 minutes | P2 | Page on-call |
| Dashboard error rate | > 2% of requests returning 5xx (5-min window) | P2 | Page on-call |
| ClickHouse disk usage | > 80% of allocated storage | P3 | Notify team |
| Dead-letter queue growing | `dead_letter_count` increasing over 10 minutes | P3 | Notify team |
| LLM API errors | > 10 failures in 5 minutes | P3 | Notify team |
| Certificate expiry | TLS cert expires in < 14 days | P3 | Notify team |

## 7. Self-Hosted Observability

Self-hosters get a lightweight but complete observability story without running additional services.

### 7.1 What Ships by Default

| Capability | Mechanism | No Extra Setup |
|------------|-----------|----------------|
| Logs | Structured JSON to stdout → `yavio logs` or `docker-compose logs` | Yes |
| Health checks | `GET /health` endpoints + Docker healthchecks | Yes |
| Diagnostics | `yavio doctor` — checks Node.js, Docker, ports, connectivity, database health | Yes |
| Status | `yavio status` — shows service status, uptime, versions | Yes |
| Request correlation | `requestId` in all log lines + `X-Request-Id` response header | Yes |

### 7.2 Optional: Bring Your Own

| Capability | How to Enable |
|------------|---------------|
| Metrics dashboards | Scrape `/metrics` endpoints with your own Prometheus. Import community Grafana dashboards. |
| Distributed tracing | Set `OTEL_EXPORTER_OTLP_ENDPOINT` to your Jaeger/Tempo/Zipkin instance. |
| Error tracking | Set `SENTRY_DSN` to your own Sentry project (self-hosted or sentry.io). |
| Log aggregation | Configure Docker log driver to forward to your ELK/Loki/CloudWatch stack (via `docker-compose.prod.yml` overrides). |

### 7.3 `yavio doctor` Checks

The CLI `doctor` command (see [cli/architecture.md](../cli/architecture.md)) runs diagnostic checks that serve as a lightweight monitoring tool for self-hosters:

| Check | What It Verifies |
|-------|------------------|
| Docker availability | Docker daemon running, compose version compatible |
| Service health | All containers running, health checks passing |
| Port conflicts | Ports 3000, 3001 not in use by other processes |
| Database connectivity | PostgreSQL and ClickHouse accepting connections |
| Disk space | Data volumes have > 1 GB free |
| Memory | System has > 2 GB available RAM |
| DNS resolution | Can resolve ingestion endpoint (relevant for Cloud SDK users) |

## 8. Dependencies

New dependencies introduced by this spec:

| Package | Service | Purpose | Why This One |
|---------|---------|---------|-------------|
| pino | all | Structured JSON logging | Fastest Node.js logger. Native Fastify integration. JSON-first. |
| prom-client | all | Prometheus metrics | Official Prometheus client for Node.js. Industry standard. |
| @sentry/node | ingest | Error tracking | Industry standard. Lightweight when DSN is unset (no-op). |
| @sentry/nextjs | dashboard | Error tracking (SSR + client) | Official Next.js integration. Source map support. |
| @opentelemetry/sdk-node | all (Cloud) | Distributed tracing | Official OTel SDK. No-op when exporter is unconfigured. |
| @opentelemetry/exporter-trace-otlp-http | all (Cloud) | OTLP trace export | Standard OTLP exporter. Works with any OTLP-compatible backend. |

> **Zero-overhead principle:** Every observability dependency initializes as a no-op when its corresponding env var is unset (`SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`). Pino and prom-client are always active but add negligible overhead (Pino: < 1ms per log call, prom-client: < 0.1ms per metric increment). Self-hosters who never look at `/metrics` pay no meaningful cost for its existence.

## 9. Environment Variables Summary

All observability-related environment variables in one place:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `METRICS_BEARER_TOKEN` | No | — | Bearer token for `/metrics` endpoint. If set, requests require `Authorization: Bearer <token>`. If unset, endpoint is open. |
| `LOG_LEVEL` | No | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `SENTRY_DSN` | No | — | Sentry DSN. If unset, error tracking is disabled. |
| `SENTRY_ENVIRONMENT` | No | `production` | Sentry environment tag |
| `SENTRY_TRACES_SAMPLE_RATE` | No | `0.1` | Fraction of Sentry performance transactions to capture |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | — | OTLP endpoint for distributed tracing. If unset, tracing is disabled. |
| `OTEL_SERVICE_NAME` | No | Auto-detected | Service name in traces |
| `OTEL_TRACES_SAMPLER` | No | `parentbased_traceidratio` | OTel sampling strategy |
| `OTEL_TRACES_SAMPLER_ARG` | No | `0.1` | OTel sampling rate |
