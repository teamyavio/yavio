# Documentation Site Architecture

The documentation site is a **Fumadocs** (Next.js) application living in the platform monorepo at `packages/docs/`. It serves two audiences: **users** (developers integrating the SDK, self-hosting operators, dashboard users) and **contributors** (developers building the platform itself). Both audiences are served from a single site at `docs.yavio.ai` (Cloud) / `localhost:3002/docs` (self-hosted).

## Why Fumadocs

| Criterion | Fumadocs | Docusaurus | Nextra | Mintlify |
|-----------|----------|------------|--------|----------|
| Framework | Next.js 15 (RSC) | React (CSR) | Next.js | Hosted SaaS |
| Matches platform stack | Yes — same Next.js 15, Tailwind, shadcn | No | Partial | No |
| Server Components | Yes | No | Partial | N/A |
| Built-in search | Yes (API route) | Plugin (Algolia) | Yes | Yes (AI) |
| MDX support | Yes | Yes | Yes | Yes |
| Self-hostable | Yes | Yes | Yes | No |
| Cost | Free (MIT) | Free (MIT) | Free (MIT) | $0–300+/mo |
| OpenAPI auto-gen | Plugin (`fumadocs-openapi`) | Plugin | No | Built-in |

Fumadocs is the natural choice: it runs on the same stack as the dashboard (Next.js 15, Tailwind, RSC), can share UI components via the monorepo, supports OpenAPI-driven API reference generation, and is free.

## Monorepo Placement

The docs site lives alongside the dashboard, ingestion API, and CLI in the platform monorepo:

```
yavio-platform/
├── packages/
│   ├── dashboard/          # Next.js 15 dashboard
│   ├── ingest/             # Ingestion API
│   ├── cli/                # CLI tool
│   ├── shared/             # Shared types
│   └── docs/               # ← Documentation site (Fumadocs)
│       ├── app/
│       │   ├── (home)/
│       │   │   └── page.tsx           # Landing page (hero, feature grid)
│       │   ├── docs/
│       │   │   └── [[...slug]]/
│       │   │       └── page.tsx       # Fumadocs page renderer
│       │   ├── api/
│       │   │   └── search/
│       │   │       └── route.ts       # Full-text search endpoint
│       │   └── layout.tsx             # Root layout (nav, sidebar)
│       ├── content/
│       │   └── docs/                  # All MDX content (see Content Structure)
│       ├── components/                # Custom MDX components (CodeGroup, Callout, etc.)
│       ├── lib/
│       │   └── source.ts             # Fumadocs content source adapter
│       ├── public/
│       │   └── img/                   # Screenshots, diagrams
│       ├── openapi/
│       │   ├── ingest.yaml            # Ingestion API OpenAPI spec
│       │   └── dashboard.yaml         # Dashboard API OpenAPI spec
│       ├── source.config.ts           # Fumadocs content configuration
│       ├── next.config.js
│       ├── tailwind.config.ts
│       ├── package.json
│       └── tsconfig.json
├── docker-compose.yml
└── ...
```

### Shared Monorepo Dependencies

The docs site imports from the monorepo's shared packages where useful:

| Import | Source | Usage |
|--------|--------|-------|
| UI components | `@yavio/ui` (or `packages/shared`) | Consistent buttons, cards, badges across docs and dashboard |
| Tailwind config | `@yavio/config/tailwind` | Same design tokens (colors, fonts, spacing) |
| TypeScript config | `@yavio/config/tsconfig` | Shared compiler settings |
| Event types | `@yavio/shared/events` | Type-checked code examples that stay in sync with the codebase |

## Content Structure

All documentation content lives in `packages/docs/content/docs/` as MDX files. The directory structure determines the sidebar navigation. Numeric prefixes control ordering (Fumadocs convention).

```
content/docs/
├── index.mdx                              # Docs landing / overview
│
├── 01-getting-started/
│   ├── index.mdx                          # Getting started overview
│   ├── 01-quickstart.mdx                  # 5-minute Cloud quickstart
│   ├── 02-self-hosted.mdx                 # Self-hosted setup (Docker + CLI)
│   └── 03-first-dashboard.mdx             # First look at your analytics
│
├── 02-sdk/
│   ├── index.mdx                          # SDK overview (entry points, install)
│   ├── 01-server-setup.mdx                # withYavio() setup & configuration
│   ├── 02-explicit-api.mdx                # .identify(), .step(), .track(), .conversion()
│   ├── 03-widget-sdk.mdx                  # useYavio() React hook for ChatGPT widgets
│   ├── 04-configuration.mdx               # Config precedence: code > env > .yaviorc.json
│   ├── 05-platform-detection.mdx          # How the SDK detects ChatGPT, Claude, Cursor, etc.
│   └── 06-troubleshooting.mdx             # Common SDK issues and fixes
│
├── 03-dashboard/
│   ├── index.mdx                          # Dashboard overview
│   ├── 01-workspaces.mdx                  # Workspace creation, team invites, roles
│   ├── 02-projects.mdx                    # Project setup, API key management
│   ├── 03-overview.mdx                    # Overview KPIs view
│   ├── 04-tool-explorer.mdx               # Per-tool analytics view
│   ├── 05-funnels.mdx                     # Combined server+widget funnel view
│   ├── 06-users.mdx                       # User analytics, retention, cohorts
│   ├── 07-paths.mdx                       # Path exploration view
│   ├── 08-live-feed.mdx                   # Real-time event stream
│   └── 09-errors.mdx                      # Error analysis view
│
├── 04-self-hosting/
│   ├── index.mdx                          # Self-hosting overview
│   ├── 01-requirements.mdx                # System requirements (Docker, ports, resources)
│   ├── 02-installation.mdx                # docker-compose up walkthrough
│   ├── 03-configuration.mdx               # Environment variables reference
│   ├── 04-upgrades.mdx                    # yavio update, migration notes
│   ├── 05-backup-restore.mdx              # Data backup and restore procedures
│   └── 06-production.mdx                  # Production hardening (TLS, reverse proxy, resource limits)
│
├── 05-cli/
│   ├── index.mdx                          # CLI overview and installation
│   └── 01-commands.mdx                    # Full command reference (init, up, down, status, logs, update, reset, doctor)
│
├── 06-api-reference/
│   ├── index.mdx                          # API reference overview
│   ├── 01-ingestion.mdx                   # Auto-generated from openapi/ingest.yaml
│   └── 02-dashboard.mdx                   # Auto-generated from openapi/dashboard.yaml
│
├── 07-concepts/
│   ├── index.mdx                          # Key concepts overview
│   ├── 01-events.mdx                      # Event types and fields
│   ├── 02-metrics.mdx                     # Derived metrics and how they're computed
│   ├── 03-traces.mdx                      # Trace ID, combined funnel, cross-layer correlation
│   ├── 04-user-identification.mdx         # .identify() behavior, retroactive stitching, anonymous sessions
│   └── 05-security.mdx                    # PII stripping, widget JWT auth, API key scoping
│
├── 08-pricing/
│   ├── index.mdx                          # Pricing overview (self-hosted free, Cloud usage-based)
│   └── 01-billing.mdx                     # Billing details, spending caps, Stripe integration
│
└── 09-contributing/
    ├── index.mdx                          # Contributing overview, code of conduct
    ├── 01-development-setup.mdx           # Clone, install, run locally (without Docker)
    ├── 02-architecture.mdx                # Platform architecture overview for contributors
    ├── 03-project-structure.mdx           # Monorepo layout, package responsibilities
    ├── 04-testing.mdx                     # How to run tests, write tests, test categories
    ├── 05-code-style.mdx                  # Biome config, TypeScript conventions, PR process
    └── 06-specs.mdx                       # How to read and update the /specs directory
```

### Content Source Configuration

```typescript
// source.config.ts
import { defineDocs } from "fumadocs-mdx/config";

export const { docs, meta } = defineDocs({
  dir: "content/docs",
});
```

### Category Metadata

Each directory uses Fumadocs `meta.json` for sidebar labels and ordering:

```json
// content/docs/02-sdk/meta.json
{
  "title": "SDK",
  "description": "Integrate Yavio into your MCP server and ChatGPT widgets",
  "icon": "Package"
}
```

## Audience Split: Users vs Contributors

The content structure serves both audiences from a single site with clear separation:

| Section | Audience | Purpose |
|---------|----------|---------|
| Getting Started | Users (all) | Fastest path to first event |
| SDK | Users (developers) | SDK integration reference |
| Dashboard | Users (all) | Using the analytics dashboard |
| Self-Hosting | Users (operators) | Running the platform on your own infrastructure |
| CLI | Users (operators + developers) | CLI command reference |
| API Reference | Users (developers) | HTTP API documentation |
| Concepts | Users (all) | Understanding the data model and platform mechanics |
| Pricing | Users (all) | Pricing model and billing |
| Contributing | Contributors | Building and extending the platform |

The sidebar visually separates these with group labels: **"Using Yavio"** (sections 01–08) and **"Contributing"** (section 09).

## API Reference Generation

API reference pages are auto-generated from OpenAPI specs using [`fumadocs-openapi`](https://fumadocs.vercel.app/docs/ui/openapi).

### OpenAPI Specs

Two OpenAPI specs are maintained in `packages/docs/openapi/`:

| Spec | Source | Covers |
|------|--------|--------|
| `ingest.yaml` | Ingestion API | `POST /v1/events`, `POST /v1/widget-tokens`, `GET /health` |
| `dashboard.yaml` | Dashboard API | All 48 dashboard routes (auth, workspaces, analytics, billing) |

These specs are the source of truth for the API reference. They are version-controlled alongside the docs and updated when API routes change.

### Generation Pipeline

```typescript
// lib/generate-api-docs.ts
import { generateFiles } from "fumadocs-openapi";

// Run at build time or via npm script
await generateFiles({
  input: ["./openapi/ingest.yaml", "./openapi/dashboard.yaml"],
  output: "./content/docs/06-api-reference",
  groupBy: "tag",
});
```

This generates MDX files with:
- Endpoint descriptions, parameters, request/response schemas
- Interactive "Try it" panels (configurable)
- Typed request/response examples

## Search

Fumadocs provides built-in full-text search via an API route. No external service required.

```typescript
// app/api/search/route.ts
import { source } from "@/lib/source";
import { createSearchAPI } from "fumadocs-core/search/server";

export const { GET } = createSearchAPI("advanced", {
  indexes: source.getPages().map((page) => ({
    title: page.data.title,
    structuredData: page.data.structuredData,
    id: page.url,
    url: page.url,
  })),
});
```

Search is accessible via `Cmd+K` on the docs site. For larger deployments, this can be swapped for Algolia or Orama without changing the UI.

## Custom MDX Components

Docs pages use custom components for consistent formatting:

| Component | Purpose | Example |
|-----------|---------|---------|
| `<Callout>` | Info, warning, tip boxes | `<Callout type="warn">API keys are shown once</Callout>` |
| `<CodeGroup>` | Tabbed code blocks (e.g., npm/pnpm/yarn) | Install commands side-by-side |
| `<Steps>` | Numbered step-by-step guides | Getting started walkthroughs |
| `<Card>` | Linked cards for navigation | Feature grid on landing page |
| `<APIPlayground>` | Interactive API tester (from fumadocs-openapi) | API reference pages |
| `<TypeTable>` | Auto-generated type documentation | SDK config options from TypeScript types |

Fumadocs ships most of these out of the box. Custom components live in `packages/docs/components/`.

## Versioning Strategy

**No versioned docs for v1.** The docs always reflect the latest release. This matches PostHog, Supabase, Umami, and Cal.com — all ship unversioned docs.

Versioning will be reconsidered when:
- A breaking change requires users to reference old API behavior
- Multiple major versions are supported simultaneously

If needed, Fumadocs supports versioned content via directory-based snapshots (similar to Docusaurus).

## Deployment

| Mode | URL | How |
|------|-----|-----|
| **Cloud** | `docs.yavio.ai` | Deployed as a standalone Next.js app (Vercel, Fly.io, or Coolify). Rebuilt on push to `main`. |
| **Self-hosted** | `localhost:3002` | Included in `docker-compose.yml` as `yavio-docs` service. Pre-built static export (`next build && next export`) served by a lightweight container. |
| **Development** | `localhost:3002` | `pnpm --filter docs dev` from the monorepo root. |

### Docker Service

```yaml
# docker-compose.yml (addition)
yavio-docs:
  image: yavio/docs:latest
  ports:
    - "3002:3000"
  restart: unless-stopped
```

The docs container is optional for self-hosted deployments. Operators can disable it if they prefer reading docs online at `docs.yavio.ai`.

## Relationship to /specs

The `/specs` directory in this repository contains the **pre-build technical architecture specification** — the source of truth for implementation decisions. The docs site contains the **post-build user-facing documentation** — the source of truth for how to use the platform.

| Aspect | `/specs` | `packages/docs` |
|--------|----------|-----------------|
| Audience | Internal (builders) | External (users + contributors) |
| Content | Architecture decisions, schemas, data flow | How-to guides, API reference, tutorials |
| Format | Markdown (GitHub-rendered) | MDX (Fumadocs site) |
| Lifecycle | Written before code, updated as decisions change | Written alongside code, updated with releases |
| Versioned | No (single living document) | No (latest release only) |

Some content flows from specs to docs: event schemas, API route tables, and architecture diagrams originate in specs and are adapted (not copied) into user-facing docs with appropriate context and examples.
