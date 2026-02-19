# 4. Implementation Roadmap

## 4.0 Open-Source Preparation

Before publishing the repository, complete the following:

| Task | Description | Status |
|------|-------------| ------ |
| Add `LICENSE` | Add an MIT license file to the repository root | done |
| Add root `README.md` | Project overview, what Yavio is, quick-start instructions | done |
| Add `.gitignore` | Exclude `.env`, `node_modules/`, build artifacts, IDE files, yavio setup json | done |
| Add `CONTRIBUTING.md` | Contribution guidelines: code style, PR process, branch conventions | done |
| Add `CODE_OF_CONDUCT.md` | Adopt Contributor Covenant or equivalent | done |
| Add `SECURITY.md` | Responsible disclosure policy for security vulnerabilities | done |
| Add `.env.example` | Template of required environment variables (no real values) | done |
| Add GitHub templates | `.github/ISSUE_TEMPLATE/` and `.github/PULL_REQUEST_TEMPLATE.md` | done |

## 4.1 Build Sequence

Ordered by dependency chain and risk. Each phase produces a testable, deployable increment. Detailed phase content lives in per-service roadmap files.

| Phase | Service | Details | status |
|-------|---------|---------| ------ |
| 1. Database Schemas & Docker Foundation | [infrastructure/roadmap.md](./infrastructure/roadmap.md) | PostgreSQL + ClickHouse schemas, Docker Compose, migrations | |
| 1a. Monorepo Foundation | [infrastructure/monorepo-foundation.md](./infrastructure/monorepo-foundation.md) | Turborepo, Biome, Vitest, tsup, `packages/shared` scaffold, per-package tsconfigs & scripts | |
| 1b. CI/CD Pipeline | [infrastructure/ci-cd.md](./infrastructure/ci-cd.md) | GitHub Actions: lint, build, test gates; publish & deploy jobs added as services ship | |
| 1c. Docs Scaffolding | [docs/roadmap.md](./docs/roadmap.md) | Fumadocs site setup, concepts section, contributing guide, OpenAPI stubs | |
| 2. Ingestion API | [ingest/roadmap.md](./ingest/roadmap.md) | Fastify/Hono server, event endpoint, auth, PII stripping, ClickHouse writer; add CI jobs for ingest | |
| 3. Server SDK HTTP Transport | [sdk/roadmap.md](./sdk/roadmap.md) | withYavio() proxy, batch queue, HTTP transport, explicit API; add CI jobs for sdk | |
| 3b. Docs: SDK & Ingestion | [docs/roadmap.md](./docs/roadmap.md) | Quickstart guide, SDK reference, ingestion API reference, user identification concepts | |
| 4. Auth & Workspace Management | [dashboard/roadmap.md](./dashboard/roadmap.md) | Next.js 16, NextAuth.js v5, workspace CRUD, roles, invitations; add CI jobs for dashboard | |
| 5. Dashboard Analytics Views | [dashboard/roadmap.md](./dashboard/roadmap.md) | Overview, tools, funnels, users, paths, live feed, errors views | |
| 5b. Docs: Dashboard | [docs/roadmap.md](./docs/roadmap.md) | Workspace, project, and analytics view docs; dashboard API reference | |
| 6. React Widget SDK | [sdk/roadmap.md](./sdk/roadmap.md) | useYavio() hook, auto-config, widget JWT auth, beacon teardown; add CI jobs for widget | |
| 7. CLI & Docker Packaging | [cli/roadmap.md](./cli/roadmap.md) | yavio init/up/down/status/doctor, Dockerfiles, image publishing; add CI jobs for cli | |
| 7b. Docs: Widget, CLI & Self-Hosting | [docs/roadmap.md](./docs/roadmap.md) | Widget SDK docs, CLI reference, self-hosting guide | |
| 8. Polish & Ship Core Platform | [sdk](./sdk/roadmap.md), [dashboard](./dashboard/roadmap.md), [docs](./docs/roadmap.md) | tsup build, npm publish, onboarding flow, E2E tests, security review, docs polish & deploy | |
| 9. CD Pipeline | [infrastructure/ci-cd.md](./infrastructure/ci-cd.md) | release-npm.yml, release-docker.yml, deploy-cloud.yml, scheduled.yml; npm provenance, GHCR multi-arch images, staging/production deploy with manual approval | |
| 11. Security Hardening | [infrastructure/roadmap.md](./infrastructure/roadmap.md) | Server-side trace correlation, widget event validation | |