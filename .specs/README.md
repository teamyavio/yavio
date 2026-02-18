# Yavio Platform — Technical Architecture Specification

**Product Analytics for MCP Apps & ChatGPT Apps**

- **Version:** 1.0
- **Date:** February 2026
- **Status:** Pre-Build — Architecture Decisions Locked

## Overview

This specification covers the technical architecture for the **Yavio Platform** — product analytics for MCP Apps and ChatGPT Apps. The platform gives developers complete visibility into how users interact with their apps — from tool calls on the server to conversions in the widget UI — with user identification, retention analysis, funnel visualization, and real-time event feeds.

It consists of an open-source SDK (`@yavio/sdk`), a high-throughput event ingestion API, a full-featured web dashboard with workspaces, team auth, and project management, and a proprietary intelligence service for premium analytics (outside of this repo). The core platform is open source (MIT), backed by ClickHouse (analytics) and PostgreSQL (application data), deployable via `docker-compose` for self-hosting or as a managed SaaS. The intelligence service is proprietary and available in Cloud Pro and Enterprise tiers.

## Document Structure

### Platform-Wide

| File | Description |
|------|-------------|
| [01_executive-summary.md](./01_executive-summary.md) | Scope, out-of-scope, key architecture decisions, pricing tiers |
| [02_package-architecture.md](./02_package-architecture.md) | Package architecture overview with links to per-service specs |
| [03_testing.md](./03_testing.md) | Testing strategy overview with links to per-service details |
| [04_roadmap.md](./04_roadmap.md) | Implementation roadmap overview with links to per-service details |
| [05_appendix.md](./05_appendix.md) | Dependencies, performance targets, open questions |
| [telemetry.md](./06_telemetry.md) | Anonymous usage telemetry (opt-out) from SDK and self-hosted instances |
| [metrics/events.md](./metrics/events.md) | All captured event types and their fields |
| [metrics/metrics.md](./metrics/metrics.md) | Derived metrics computed from events |
| [error-catalog.md](./07_error-catalog.md) | Comprehensive error code catalog across all services (YAVIO-1000 through YAVIO-7999) |

### SDK (`@yavio/sdk`)

| File | Description |
|------|-------------|
| [sdk/architecture.md](./sdk/architecture.md) | Package structure, entry points, exports field, directory layout, build config |
| [sdk/server-sdk.md](./sdk/server-sdk.md) | withYavio() proxy, explicit tracking API, HTTP batch transport, trace ID, platform detection |
| [sdk/react-widget-sdk.md](./sdk/react-widget-sdk.md) | useYavio() hook, auto-config, direct-to-ingestion transport |
| [sdk/testing.md](./sdk/testing.md) | SDK test categories and key scenarios |
| [sdk/roadmap.md](./sdk/roadmap.md) | SDK implementation phases (3, 6, 8) |

### Ingestion API (`yavio/ingest`)

| File | Description |
|------|-------------|
| [ingest/event-pipeline.md](./ingest/event-pipeline.md) | Two-phase pipeline: SDK batch queue → ingestion API → ClickHouse |
| [ingest/testing.md](./ingest/testing.md) | Ingestion API test categories and key scenarios |
| [ingest/roadmap.md](./ingest/roadmap.md) | Ingestion API implementation phase (2) |

### Dashboard (`yavio/dashboard`)

| File | Description |
|------|-------------|
| [dashboard/architecture.md](./dashboard/architecture.md) | Next.js dashboard: auth, workspaces, analytics views, onboarding |
| [dashboard/design-guide.md](./dashboard/design-guide.md) | Visual design: color system, typography, layout, components, charts, accessibility |
| [dashboard/testing.md](./dashboard/testing.md) | Dashboard test categories and key scenarios |
| [dashboard/roadmap.md](./dashboard/roadmap.md) | Dashboard implementation phases (4, 5, 8) |

### CLI (`@yavio/cli`)

| File | Description |
|------|-------------|
| [cli/architecture.md](./cli/architecture.md) | Package definition, directory layout, build config, commands: init, up/down, status, doctor |
| [cli/roadmap.md](./cli/roadmap.md) | CLI implementation phase (7) |

### Pricing & Billing

| File | Description |
|------|-------------|
| [pricing/tiers.md](./pricing/tiers.md) | Pricing tier comparison, feature gating, upgrade paths |
| [pricing/billing.md](./pricing/billing.md) | Stripe billing integration (Cloud only): checkout, metering, webhooks |

### Documentation Site (`packages/docs`)

| File | Description |
|------|-------------|
| [docs/architecture.md](./docs/architecture.md) | Fumadocs site architecture, content structure, user vs contributor docs, API reference generation, search, deployment |
| [docs/roadmap.md](./docs/roadmap.md) | Documentation implementation phases (incremental, alongside platform phases) |

### Infrastructure

| File | Description |
|------|-------------|
| [infrastructure/platform-layout.md](./infrastructure/platform-layout.md) | Docker services overview, full platform directory layout |
| [infrastructure/storage-layer.md](./infrastructure/storage-layer.md) | ClickHouse schema (events), PostgreSQL schema (users, workspaces, projects, API keys), schema evolution policy |
| [infrastructure/observability.md](./infrastructure/observability.md) | Structured logging, Prometheus metrics, error tracking (Sentry), distributed tracing (OTel), Cloud alerting |
| [infrastructure/deployment.md](./infrastructure/deployment.md) | Docker Compose config, self-hosted vs managed SaaS deployment |
| [infrastructure/ci-cd.md](./infrastructure/ci-cd.md) | GitHub Actions CI/CD pipeline: lint, build, test, publish, deploy |
| [infrastructure/testing.md](./infrastructure/testing.md) | Infrastructure test categories and end-to-end scenarios |
| [infrastructure/roadmap.md](./infrastructure/roadmap.md) | Infrastructure implementation phases (1, 11) |
