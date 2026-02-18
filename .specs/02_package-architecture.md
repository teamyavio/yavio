# 2. Package Architecture

The Yavio Platform — product analytics for MCP Apps and ChatGPT Apps — consists of four independently deployed components: the **SDK** (npm package installed by developers), the **CLI** (npm package for SDK setup and self-hosted platform management), the **Core Platform** (open-source Docker-based dashboard, ingestion API, and databases), and the **Intelligence Service** (proprietary microservice for premium analytics features, outside of this repo).

## Per-Service Architecture Specs

| Component | Architecture Spec | Description |
|-----------|------------------|-------------|
| SDK | [sdk/architecture.md](./sdk/architecture.md) | npm package structure, entry points, exports field, directory layout, build config |
| SDK — Server | [sdk/server-sdk.md](./sdk/server-sdk.md) | withYavio() proxy, explicit tracking API, HTTP batch transport, trace ID, platform detection |
| SDK — React Widget | [sdk/react-widget-sdk.md](./sdk/react-widget-sdk.md) | useYavio() hook, auto-config, direct-to-ingestion transport |
| Ingestion API | [ingest/event-pipeline.md](./ingest/event-pipeline.md) | Two-phase pipeline: SDK batch queue → ingestion API → ClickHouse |
| Dashboard | [dashboard/architecture.md](./dashboard/architecture.md) | Next.js dashboard: auth, workspaces, analytics views, onboarding |
| CLI | [cli/architecture.md](./cli/architecture.md) | Package definition, directory layout, commands: init, up/down, status, doctor |
| Platform Layout | [infrastructure/platform-layout.md](./infrastructure/platform-layout.md) | Docker services overview, full platform directory layout |
| Storage Layer | [infrastructure/storage-layer.md](./infrastructure/storage-layer.md) | ClickHouse schema (events), PostgreSQL schema (users, workspaces, projects, API keys) |
| Deployment | [infrastructure/deployment.md](./infrastructure/deployment.md) | Docker Compose config, self-hosted vs managed SaaS deployment |
| CI/CD Pipeline | [infrastructure/ci-cd.md](./infrastructure/ci-cd.md) | GitHub Actions CI/CD pipeline: lint, build, test, publish, deploy |
