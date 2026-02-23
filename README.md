<p align="center">
  <img src="https://i.imgur.com/EIwgLHP.png" alt="Yavio Logo" width="200">
</p>

<p align="center">
  <strong>Yavio</strong><br>
  Product analytics for MCP Apps and ChatGPT Apps.<br>
  Open-source. Self-hosted or Cloud.
</p>

<p align="center">
  <a href="https://github.com/yavio-ai/yavio-analytics/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/status-v0.1_alpha-orange" alt="v0.1 Alpha">
  <a href="https://discord.gg/BprRh2fr"><img src="https://img.shields.io/badge/Discord-Join%20us-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
</p>

---

Yavio is the first Analytics and Visibility layer for ChatGPT Apps and MCP Apps. It captures how users interact with your MCP tools and ChatGPT App widgets: tool calls, conversions, funnels, retention, errors — with a 3-line SDK integration and a full analytics dashboard.

The entire platform is **open source (MIT)**. Self-host with Docker or use [Yavio Cloud](https://yavio.ai) (coming soon).

## Features

- **Automatic MCP instrumentation** — `withYavio()` wraps your MCP server and captures every tool call, resource read, and prompt with zero config
- **User identification** — `.identify(userId, traits)` ties events to known users for retention, cohorts, and per-user analytics
- **Explicit tracking** — `.step()`, `.track()`, `.conversion()` for custom funnel stages and business events
- **Widget SDK** — `useYavio()` React hook for tracking user interactions in ChatGPT App widgets
- **Full analytics dashboard** — overview, per-tool breakdowns, funnels, user paths, retention, live event feed, error analysis
- **Workspace-based multi-tenancy** — teams, roles (admin/member/viewer), invitations, multiple projects per workspace
- **PII stripping** — automatic removal of identity data before storage
- **Self-hosted or Cloud** — same codebase, same features, no feature gating

## Architecture

```
Developer's MCP Server          Yavio Platform
  │                               │
  │  @yavio/sdk                   │
  │    withYavio(server)          │
  │                               │
  └── POST /v1/events ──────────► Ingestion API (Fastify)
                                    │
                                    ├── PII stripping
                                    ├── Schema validation
                                    └── ClickHouse write
                                          │
  Browser ──────────────────────► Dashboard (Next.js 16)
                                    │
                                    ├── ClickHouse (analytics)
                                    └── PostgreSQL (app data)
```

| Component | Description |
|-----------|-------------|
| **@yavio/sdk** | npm package — server-side `withYavio()` proxy + React `useYavio()` hook |
| **@yavio/cli** | CLI for SDK setup (`yavio init`) and self-hosted management (`yavio up/down/status`) |
| **Ingestion API** | High-throughput Fastify service for event collection |
| **Dashboard** | Next.js 16 web app with auth, workspaces, and analytics views |
| **ClickHouse** | Analytics event storage (MergeTree engine) |
| **PostgreSQL** | Application data (users, workspaces, projects, API keys) |

## Quick Start

### Option A: Yavio Cloud

> **Coming soon** — Yavio Cloud is not yet available. For now, use the self-hosted option below.

### Option B: Self-Hosted (Docker)

```bash
# Clone the repo
git clone https://github.com/yavio-ai/yavio-analytics.git
cd yavio-analytics

# Configure environment
cp .env.example .env
# Edit .env — fill in the required secrets (see comments in the file)

# Start all services
docker compose up -d

# Or use the CLI
npm i -g @yavio/cli
yavio up
```

The dashboard is available at `http://localhost:3000` and the ingestion API at `http://localhost:3001`.

### Identify Users

Tie events to known users for retention, cohorts, and per-user analytics:

```typescript
server.tool("checkout", { items: z.array(z.string()) }, async (params, ctx) => {
  ctx.yavio.identify("user_123", { plan: "pro", company: "Acme" });
  ctx.yavio.conversion("purchase", { value: 99 });

  return { content: [{ type: "text", text: "Order placed." }] };
});
```

## Self-Hosting Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | 2 cores | 4+ cores |
| RAM | 4 GB | 8+ GB |
| Disk | 20 GB | 100+ GB |
| Docker | v24+ | Latest stable |
| docker-compose | v2.20+ | Latest stable |

For production deployments, see the [self-hosting guide](https://docs.yavio.ai/self-hosting/production) — you'll need a TLS-terminating reverse proxy in front of the dashboard and ingestion API.

## Contributing

We welcome contributions! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a PR.

## Security

Found a vulnerability? Please report it responsibly — see [SECURITY.md](SECURITY.md). Do **not** open a public issue.

## License

MIT — see [LICENSE](LICENSE).

Copyright (c) 2026 Yavio GmbH
