# Documentation Roadmap

Documentation is built incrementally alongside the platform. Each phase produces docs for the features shipped in the corresponding platform phase (see [04_roadmap.md](../04_roadmap.md)). The docs site scaffolding is set up in Phase 1 so content can be added as each service becomes functional.

## Phase 1: Docs Scaffolding (alongside Platform Phase 1–2)

Set up the Fumadocs site and write foundational content before the first user-facing feature ships.

**Deliverables:**

- [ ] Initialize `packages/docs` with Fumadocs (`create-fumadocs-app`)
- [ ] Configure `source.config.ts`, `tailwind.config.ts`, root layout
- [ ] Set up search API route (`/api/search`)
- [ ] Add docs container to `docker-compose.yml` (optional service)
- [ ] Write landing page (`content/docs/index.mdx`)
- [ ] Write **Concepts** section:
  - Events and event types
  - Metrics and how they're computed
  - Traces and combined funnels
  - Security model (PII stripping, API key scoping)
- [ ] Write **Contributing** section:
  - Development setup (clone, install, run)
  - Architecture overview (services, data flow)
  - Project structure (monorepo layout)
  - Testing guide
  - Code style and PR process
  - How to read and update `/specs`
- [ ] Create OpenAPI spec stubs for ingestion API (`openapi/ingest.yaml`)

**Why now:** Contributing docs are needed before external contributors can participate. Concepts docs provide the mental model for everything that follows. The docs scaffolding is low-effort and avoids a documentation backlog later.

## Phase 2: SDK & Ingestion Docs (alongside Platform Phase 2–3)

The SDK and ingestion API are the first user-facing components. Document them as they ship.

**Deliverables:**

- [ ] Write **Getting Started — Quickstart** (Cloud path: install SDK, get API key, see first event)
- [ ] Write **SDK** section:
  - Server setup (`withYavio()` configuration, options)
  - Explicit API (`.identify()`, `.step()`, `.track()`, `.conversion()`)
  - Configuration precedence (code > env vars > `.yaviorc.json`)
  - Platform detection
  - Troubleshooting
- [ ] Write **API Reference — Ingestion API** (auto-generate from `openapi/ingest.yaml`)
- [ ] Write **Concepts — User Identification** (`.identify()` behavior, anonymous sessions, retroactive stitching)
- [ ] Add `fumadocs-openapi` and configure generation pipeline

## Phase 3: Dashboard Docs (alongside Platform Phase 4–5)

Document the dashboard as views ship. These are written for end-users (workspace admins, analysts, developers reviewing their analytics).

**Deliverables:**

- [ ] Write **Dashboard** section:
  - Workspaces (creation, invites, roles)
  - Projects (setup, API key management)
  - Overview view
  - Tool Explorer view
  - Funnel view
  - Users view (retention, cohorts, DAU/WAU/MAU)
  - Paths view
  - Live Feed view
  - Errors view
- [ ] Write **API Reference — Dashboard API** (auto-generate from `openapi/dashboard.yaml`)
- [ ] Write **Getting Started — First Dashboard** (navigating your first analytics data)

## Phase 4: Widget, CLI & Self-Hosting Docs (alongside Platform Phase 6–8)

Complete the user-facing documentation for all shipped components.

**Deliverables:**

- [ ] Write **SDK — Widget SDK** (`useYavio()` React hook, auto-configuration, zero-config setup)
- [ ] Write **CLI** section:
  - Installation (`npm i -g @yavio/cli` or `npx`)
  - Full command reference (`init`, `up`, `down`, `status`, `logs`, `update`, `reset`, `doctor`)
- [ ] Write **Self-Hosting** section:
  - System requirements
  - Installation walkthrough
  - Environment variables reference
  - Upgrades and migrations
  - Backup and restore
  - Production hardening (TLS, reverse proxy, resource limits)
- [ ] Write **Getting Started — Self-Hosted** (end-to-end: install CLI, `yavio up`, create workspace, integrate SDK)
- [ ] Write **Pricing** section (self-hosted free, Cloud tiers, billing)

## Phase 5: Polish & Launch (alongside Platform Phase 8)

Final pass before public launch.

**Deliverables:**

- [ ] Review all pages for accuracy against shipped code
- [ ] Add screenshots/GIFs for dashboard views
- [ ] Add code examples that are tested against the real SDK (import from `@yavio/shared` types)
- [ ] SEO metadata on all pages (title, description, OpenGraph)
- [ ] Deploy to `docs.yavio.ai`
- [ ] Add "Docs" link to dashboard sidebar and marketing site
- [ ] Write `CONTRIBUTING.md` in monorepo root (points to docs site contributing section)
- [ ] Write `README.md` in monorepo root (project overview, links to docs)

## Ongoing

After launch, documentation is maintained as part of the regular development process:

- **Every PR that changes user-facing behavior must include a docs update.** This is enforced by a PR template checkbox, not CI (to avoid blocking urgent fixes).
- **OpenAPI specs are updated when API routes change.** API reference pages are regenerated on build.
- **New contributors** update the contributing section when they encounter missing or outdated setup steps.
- **Quarterly review:** Audit docs for accuracy, remove stale content, update screenshots.
