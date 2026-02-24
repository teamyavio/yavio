# 9. Deployment

The Yavio platform — product analytics for MCP Apps and ChatGPT Apps — is designed to run identically in two deployment modes: **self-hosted** (developer runs Docker on their own infrastructure) and **managed SaaS** (Yavio hosts it). The same Docker images and codebase power both. Premium features are provided by an additional proprietary intelligence service, available in Cloud Pro and Enterprise On-Prem tiers.

For pricing tiers, feature gating, and billing details, see [pricing/tiers.md](../pricing/tiers.md) and [pricing/billing.md](../pricing/billing.md).

## 9.1 Self-Hosted Deployment

### 9.1.1 Docker Compose

The primary self-hosted deployment method. The recommended way to start and manage the platform is via the CLI (`@yavio/cli`), which wraps `docker-compose` with health checks and friendly output (see [CLI architecture](../cli/architecture.md)):

```bash
npm i -g @yavio/cli
yavio up       # starts all services
yavio status   # check health
yavio down     # stop all services
```

Alternatively, developers can run `docker-compose` directly:

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_DB: yavio
      POSTGRES_USER: yavio_service           # Table owner — bypasses RLS (migrations, background jobs, NextAuth)
      POSTGRES_PASSWORD: ${POSTGRES_SERVICE_PASSWORD:-yavio_dev}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./config/postgres/init-roles.sql:/docker-entrypoint-initdb.d/01-init-roles.sql
    networks:
      - backend
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U yavio_service"]
      interval: 5s
      timeout: 5s
      retries: 5

  clickhouse:
    image: clickhouse/clickhouse-server:24.3
    restart: unless-stopped
    volumes:
      - clickhouse_data:/var/lib/clickhouse
      - ./config/clickhouse/users.xml:/etc/clickhouse-server/users.d/users.xml
    networks:
      - backend
    healthcheck:
      test: ["CMD", "clickhouse-client", "--query", "SELECT 1"]
      interval: 5s
      timeout: 5s
      retries: 5

  ingest:
    image: yavio/ingest:latest
    restart: unless-stopped
    depends_on:
      clickhouse:
        condition: service_healthy
      postgres:
        condition: service_healthy
    environment:
      CLICKHOUSE_URL: http://yavio_ingest:${CLICKHOUSE_INGEST_PASSWORD:-yavio_dev}@clickhouse:8123
      DATABASE_URL: postgres://yavio_service:${POSTGRES_SERVICE_PASSWORD:-yavio_dev}@postgres:5432/yavio
      NEXTAUTH_SECRET: ${NEXTAUTH_SECRET:?NEXTAUTH_SECRET is required}
      JWT_SECRET: ${JWT_SECRET:?JWT_SECRET is required}
      API_KEY_HASH_SECRET: ${API_KEY_HASH_SECRET:?API_KEY_HASH_SECRET is required}
      PORT: 3001
    ports:
      - "3001:3001"
    networks:
      - frontend
      - backend
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/health"]
      interval: 10s
      timeout: 5s
      retries: 3

  dashboard:
    image: yavio/dashboard:latest
    restart: unless-stopped
    depends_on:
      clickhouse:
        condition: service_healthy
      postgres:
        condition: service_healthy
    environment:
      CLICKHOUSE_URL: http://yavio_dashboard:${CLICKHOUSE_DASHBOARD_PASSWORD:-yavio_dev}@clickhouse:8123
      DATABASE_URL: postgres://yavio_app:${POSTGRES_APP_PASSWORD:-yavio_dev}@postgres:5432/yavio
      DATABASE_SERVICE_URL: postgres://yavio_service:${POSTGRES_SERVICE_PASSWORD:-yavio_dev}@postgres:5432/yavio
      NEXTAUTH_URL: http://localhost:3000
      NEXTAUTH_SECRET: ${NEXTAUTH_SECRET:?NEXTAUTH_SECRET is required}
      API_KEY_HASH_SECRET: ${API_KEY_HASH_SECRET:?API_KEY_HASH_SECRET is required}
      ENCRYPTION_KEY: ${ENCRYPTION_KEY:?ENCRYPTION_KEY is required}
      SMTP_HOST: ${SMTP_HOST:-}
      SMTP_PORT: ${SMTP_PORT:-587}
      SMTP_USER: ${SMTP_USER:-}
      SMTP_PASSWORD: ${SMTP_PASSWORD:-}
      SMTP_FROM: ${SMTP_FROM:-noreply@localhost}
      PORT: 3000
    ports:
      - "3000:3000"
    networks:
      - frontend
      - backend
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/api/health"]
      interval: 10s
      timeout: 5s
      retries: 3

volumes:
  postgres_data:
  clickhouse_data:

networks:
  frontend:    # Public-facing services (ingest, dashboard)
  backend:     # Internal services (databases) — not exposed to host
```

**Database role initialization:** The PostgreSQL container runs `config/postgres/init-roles.sql` on first startup to create the `yavio_app` role with restricted privileges and enable RLS. The ClickHouse container's `config/clickhouse/users.xml` defines the `yavio_ingest`, `yavio_dashboard`, and `yavio_intelligence` users with their respective grants and row policies. See [storage-layer.md §5.1.8](./storage-layer.md#518-row-policies-tenant-isolation) and [§5.2.10](./storage-layer.md#5210-row-level-security-tenant-isolation) for full details.

### 9.1.2 Enterprise / Cloud Pro Override (docker-compose.pro.yml)

For On-Prem Enterprise customers, an additional compose file adds the intelligence service.

### 9.1.3 TLS / HTTPS Requirements

> **SECURITY WARNING:** The default Docker Compose configuration uses unencrypted HTTP and is intended **for local development only**. For any non-localhost deployment, HTTPS is **mandatory**. API keys, session cookies, and widget JWTs are transmitted in HTTP headers — without TLS, they are visible to any network observer.

**Requirements for non-localhost deployments:**

- Terminate TLS at a reverse proxy (Nginx, Traefik, Caddy) in front of the dashboard and ingestion API
- Set `NEXTAUTH_URL` to an `https://` URL
- Session cookies use `Secure; HttpOnly; SameSite=Lax` — the `Secure` flag means cookies are only sent over HTTPS
- `yavio doctor` checks for TLS when the configured endpoint is non-localhost and warns if HTTP is detected

### 9.1.4 Production Overrides

A `docker-compose.prod.yml` provides production-ready overrides:

- Resource limits (CPU, memory) per service
- External volumes for data persistence
- TLS termination via reverse proxy (Nginx/Traefik sidecar or external)
- Log drivers (JSON file with rotation, or forwarding to external logging)
- Restart policies (`unless-stopped`)
- Health check tuning

### 9.1.4 Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POSTGRES_SERVICE_PASSWORD` | Yes (prod) | `yavio_dev` | PostgreSQL password for `yavio_service` role (table owner, bypasses RLS). Used by migrations, background jobs, NextAuth, and ingestion API. |
| `POSTGRES_APP_PASSWORD` | Yes (prod) | `yavio_dev` | PostgreSQL password for `yavio_app` role (RLS enforced). Used by dashboard API routes and Server Components. |
| `CLICKHOUSE_ADMIN_PASSWORD` | Yes (prod) | `yavio_dev` | ClickHouse password for the `default` admin user. Used for migrations and user/grant management. Set at container startup by `init-default-password.sh`. |
| `CLICKHOUSE_INGEST_PASSWORD` | Yes (prod) | `yavio_dev` | ClickHouse password for `yavio_ingest` user (INSERT only, no row policies). |
| `CLICKHOUSE_DASHBOARD_PASSWORD` | Yes (prod) | `yavio_dev` | ClickHouse password for `yavio_dashboard` user (SELECT only, row policies enforced). |
| `NEXTAUTH_SECRET` | **Yes** | - | Session encryption secret. Compose will refuse to start if unset (`?` syntax). |
| `JWT_SECRET` | **Yes** | - | HMAC-SHA256 signing secret for widget JWTs. Must be a random secret known only to the ingestion API — **never use the project API key** (developers know the API key and could forge arbitrary JWTs). Compose will refuse to start if unset (`?` syntax). Generate with: `openssl rand -base64 32`. |
| `API_KEY_HASH_SECRET` | **Yes** | - | HMAC-SHA256 secret for API key hashing. Prevents precomputation attacks if the database is compromised. Generate with: `openssl rand -base64 32`. Compose will refuse to start if unset (`?` syntax). |
| `ENCRYPTION_KEY` | **Yes** | - | AES-256-GCM key for encrypting OAuth tokens at rest in PostgreSQL. Generate with: `openssl rand -base64 32`. Compose will refuse to start if unset (`?` syntax). |
| `NEXTAUTH_URL` | Yes | `http://localhost:3000` | Dashboard public URL |
| `CLICKHOUSE_URL` | No | `http://default:yavio_dev@clickhouse:8123` | ClickHouse HTTP endpoint (includes credentials) |
| `DATABASE_URL` | No | Auto-constructed | PostgreSQL connection string |
| `YAVIO_RETENTION_DAYS` | No | `90` | ClickHouse event retention in days. Self-hosted only — applied via `ALTER TABLE ... MODIFY TTL` at startup. Ignored on Cloud (hardcoded to 365). |
| `SMTP_HOST` | No | - | SMTP server hostname. If unset, email features are disabled (verification skipped, password reset/invites unavailable). See [dashboard/architecture.md §7.11](../dashboard/architecture.md#711-email-sending). |
| `SMTP_PORT` | No | `587` | SMTP port (`587` for STARTTLS, `465` for TLS). |
| `SMTP_USER` | No | - | SMTP authentication username. |
| `SMTP_PASSWORD` | No | - | SMTP authentication password. |
| `SMTP_FROM` | No | `noreply@localhost` | Default `From` address for outbound email. |
| `GITHUB_CLIENT_ID` | No | - | GitHub OAuth (optional) |
| `GITHUB_CLIENT_SECRET` | No | - | GitHub OAuth (optional) |
| `GOOGLE_CLIENT_ID` | No | - | Google OAuth (optional) |
| `GOOGLE_CLIENT_SECRET` | No | - | Google OAuth (optional) |
| `YAVIO_INTELLIGENCE_URL` | No | - | Intelligence service URL. If set, enables premium features in dashboard. |
| `YAVIO_LICENSE_KEY` | No (Enterprise) | - | License key for On-Prem Enterprise. Validates with Yavio license server. |
| `LLM_API_KEY` | No (Enterprise) | - | API key for LLM provider (OpenAI/Anthropic). Required for LLM-powered features. |
| `LLM_PROVIDER` | No | `openai` | LLM provider: `openai` or `anthropic` |
| `METRICS_BEARER_TOKEN` | No | - | Bearer token for `/metrics` endpoint authentication. If set, unauthenticated requests to `/metrics` receive 401. See [observability.md §2.7](./observability.md#27-endpoint-security). |
| `LOG_LEVEL` | No | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. See [observability.md](./observability.md). |
| `SENTRY_DSN` | No | - | Sentry DSN for error tracking. If unset, Sentry is disabled. See [observability.md §4](./observability.md#4-error-tracking). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | - | OTLP endpoint for distributed tracing. If unset, tracing is disabled. See [observability.md §5](./observability.md#5-distributed-tracing). |
| `YAVIO_CLOUD` | No | - | Set to `true` on Yavio Cloud deployments. Enables billing UI and Stripe integration. Never set by self-hosters. |
| `STRIPE_SECRET_KEY` | No (Cloud) | - | Stripe API secret key. Required when `YAVIO_CLOUD=true`. |
| `STRIPE_WEBHOOK_SECRET` | No (Cloud) | - | Stripe webhook signing secret. Required when `YAVIO_CLOUD=true`. |
| `STRIPE_PRO_PRICE_ID` | No (Cloud) | - | Stripe Price ID for the Cloud Pro usage-based plan. |

### 9.1.5 `.env.example` File

All environment variables are defined in a single root `.env.example`. There are no per-package env files — all packages load from the root `.env` via `dotenv-cli` or `tsx --env-file` in their dev/migrate scripts. Docker Compose also reads from root `.env` automatically.

```bash
# Generate .env with random secrets
./scripts/setup-env.sh

# Or manually
cp .env.example .env
# Fill in the 4 required secrets (see comments in .env.example)
```

The `setup-env.sh` script copies `.env.example` to `.env` and auto-generates `NEXTAUTH_SECRET`, `JWT_SECRET`, `API_KEY_HASH_SECRET`, and `ENCRYPTION_KEY` using `openssl rand -base64 32`.

**Important:** `API_KEY_HASH_SECRET` is shared between the dashboard and ingest service for API key validation. The single `.env` file ensures they always match.

### 9.1.6 System Requirements (Self-Hosted)

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | 2 cores | 4+ cores |
| RAM | 4 GB | 8+ GB (ClickHouse benefits from RAM) |
| Disk | 20 GB | 100+ GB (depends on event volume) |
| Docker | v24+ | Latest stable |
| docker-compose | v2.20+ | Latest stable |

## 9.2 Managed SaaS (Yavio Cloud)

The managed SaaS offering runs the same Docker images on Yavio-operated infrastructure. Developers do not need to run Docker — they install the SDK, point it at `https://ingest.yavio.ai`, and view analytics at `https://app.yavio.ai`.

### 9.2.1 Cloud Architecture

```
Developer workstation                      Yavio Cloud
  │                                         │
  │ npx @yavio/cli init                     │
  │   → creates .yaviorc.json               │
  │     (apiKey + endpoint)                 │
  │                                         │
Developer's MCP Server                      │
  │                                         │
  │ @yavio/sdk                              │
  │   apiKey: "yav_..."                │
  │   endpoint: (default: ingest.yavio.ai) │
  │   (auto-reads .yaviorc.json)            │
  │                                         │
  └── POST /v1/events ────────────────────► │ Load Balancer
                                            │   ├─ Ingestion API (auto-scaled)
                                            │   ├─ ClickHouse (managed cluster)
                                            │   ├─ PostgreSQL (managed)
                                            │   ├─ Dashboard (auto-scaled)
                                            │   └─ Intelligence Service (Cloud Pro)
                                            │
  Browser ──────────────────────────────────► https://app.yavio.ai
```

### 9.2.2 Cloud-Specific Infrastructure

| Component | Service | Notes |
|-----------|---------|-------|
| Ingestion API | Auto-scaled container instances | Horizontally scaled behind load balancer |
| Intelligence Service | Auto-scaled container instances (Pro only) | Background processing + API. Isolated from ingestion. |
| ClickHouse | Managed cluster (ClickHouse Cloud or self-managed) | Multi-shard for high-volume tenants |
| PostgreSQL | Managed instance (e.g., RDS, Neon) | Automated backups, failover |
| CDN | Cloudflare or equivalent | Dashboard static assets, DDoS protection |
| LLM API | External (OpenAI / Anthropic) | Used by intelligence service for insights, intent classification, digests |
