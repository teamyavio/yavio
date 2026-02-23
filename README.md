<p align="center">
  <img src="https://i.imgur.com/EIwgLHP.png" alt="Yavio Logo" width="200">
</p>

<h3 align="center">Product Analytics for MCP Apps and ChatGPT Apps</h3>

<p align="center">
  Open-source. Self-hosted. See how users actually use your AI tools.
</p>

<p align="center">
  <a href="https://docs.yavio.ai/docs"><img src="https://img.shields.io/badge/docs-docs.yavio.ai-blue" alt="Documentation"></a>
  <a href="https://github.com/teamyavio/yavio/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/status-v0.1_alpha-orange" alt="v0.1 Alpha">
  <a href="https://discord.gg/BprRh2fr"><img src="https://img.shields.io/badge/Discord-Join%20us-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
</p>

---

> **Alpha (v0.1)** — Yavio is under active development. APIs, configuration, and database schemas may change between releases without notice or migration paths. Do not use in production without pinning exact versions.

## What is Yavio?

Yavio is the analytics and visibility layer for MCP servers and ChatGPT Apps. It captures how AI platforms (ChatGPT, Claude, Cursor, Windsurf, VS Code, etc.) invoke your tools and how users interact with your widgets — tool calls, conversions, funnels, errors, retention — with a 3-line SDK integration and a full analytics dashboard.

The entire platform is **open source (MIT)** and self-hosted via Docker Compose. Cloud hosting is coming soon.

<p align="center">
  <img src="https://i.imgur.com/lJN73IJ.png" alt="Yavio Dashboard" width="800">
</p>

## Quick Start (Self-Hosted)

### 1. Start the platform

```bash
git clone https://github.com/teamyavio/yavio.git
cd yavio

# Generate .env with random secrets
./scripts/setup-env.sh

# Start all services
docker compose up -d
```

The dashboard is at `http://localhost:3000`, ingestion API at `http://localhost:3001`.

### 2. Create a project

Open the dashboard, register an account, create a workspace and project, then copy your API key.

### 3. Install the SDK

```bash
npm install @yavio/sdk
```

### 4. Wrap your MCP server

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withYavio } from "@yavio/sdk";

const server = withYavio(
  new McpServer({ name: "my-app", version: "1.0.0" }),
  {
    apiKey: "yav_your_key_here",
    endpoint: "http://localhost:3001/v1/events",
  }
);
```

That's it. Every tool call is now tracked automatically.

### Using the CLI

You can also use the CLI for setup and platform management:

```bash
npm i -g @yavio/cli

# Interactive SDK setup — creates .yaviorc.json
yavio init

# Platform management
yavio up          # Start services
yavio down        # Stop services (data preserved)
yavio status      # Health check and stats
yavio logs        # Tail service logs
yavio doctor      # Diagnose setup issues
```

## Features

- **Zero-config MCP instrumentation** — `withYavio()` wraps your MCP server and captures every tool call, latency, errors, and platform automatically
- **User identification** — `.identify(userId, traits)` ties events to known users for retention, cohorts, and per-user analytics
- **Funnel tracking** — `.step()`, `.track()`, `.conversion()` for custom funnel stages and business events
- **Cross-layer correlation** — a single trace ID stitches server-side tool calls and browser widget interactions into one combined funnel
- **Widget SDK** — `useYavio()` React hook auto-captures 12 interaction types (clicks, scrolls, forms, rage clicks, performance, etc.)
- **Full analytics dashboard** — overview KPIs, per-tool breakdowns, funnels, user paths, error analysis, live event feed
- **Platform detection** — auto-detects which AI platform invoked your tool (ChatGPT, Claude, Cursor, Windsurf, VS Code)
- **PII stripping** — automatic removal of emails, credit cards, SSNs, and phone numbers at both SDK and server layers
- **Multi-tenant workspaces** — teams, roles (owner/admin/member/viewer), invitations, multiple projects per workspace
- **Self-hosted** — run the full stack on your own infrastructure with `docker compose up`

## Architecture

```
┌───────────────────────────┐       ┌────────────────────────────────────────┐
│  Your App                 │       │  Yavio Platform                        │
│                           │       │                                        │
│  ┌─────────────────────┐  │       │  ┌──────────────────────────────────┐  │
│  │ @yavio/sdk          │  │       │  │ Ingestion API (Fastify)          │  │
│  │ withYavio(server)   │  │ HTTP  │  │                                  │  │
│  │                     │──┼─┐     │  │ Auth · Rate limiting             │  │
│  │ Auto-captures:      │  │ │ events │ Validation · PII stripping       │  │
│  │  · tool calls       │  │ ├────►│  └───────────────┬──────────────────┘  │
│  │  · connections      │  │ │     │                  │ write               │
│  │  · resources        │  │ │     │                  ▼                     │
│  │  · prompts          │  │ │     │  ┌───────────────────┐  ┌──────────┐  │
│  └─────────────────────┘  │ │     │  │ ClickHouse        │  │ Postgres │  │
│                           │ │     │  │ Analytics store    │  │ App data │  │
│  ┌─────────────────────┐  │ │     │  └─────────┬─────────┘  └────┬─────┘  │
│  │ Widget (React)      │  │ │     │            │ read             │ read   │
│  │ useYavio()          │──┼─┘     │            ▼                 ▼        │
│  │                     │  │       │  ┌──────────────────────────────────┐  │
│  │ Auto-captures:      │  │       │  │ Dashboard (Next.js)              │  │
│  │  · clicks, scrolls  │  │       │  │ Analytics · Teams · Projects     │  │
│  │  · forms, nav       │  │       │  └──────────────────────────────────┘  │
│  │  · rage clicks      │  │       │                 ▲                      │
│  └─────────────────────┘  │       │                 │                      │
│                           │       └─────────────────┼──────────────────────┘
└───────────────────────────┘                         │
                                        Browser ──────┘
```

| Component | Description |
|-----------|-------------|
| **@yavio/sdk** | Server-side `withYavio()` proxy + React `useYavio()` hook |
| **@yavio/cli** | SDK setup (`yavio init`) and self-hosted management (`yavio up/down/status/logs/doctor`) |
| **Ingestion API** | High-throughput Fastify service — auth, validation, PII strip, ClickHouse write |
| **Dashboard** | Next.js web app with auth, workspaces, projects, and 7 analytics views |
| **ClickHouse** | Analytics event storage (ReplacingMergeTree, built-in dedup) |
| **PostgreSQL** | Application data (users, workspaces, projects, API keys) |

## SDK Usage

### User Identification

Tie events to known users for retention and per-user analytics:

```typescript
import { yavio } from "@yavio/sdk";

server.registerTool("checkout", { inputSchema: { items: z.array(z.string()) } }, async (params) => {
  yavio.identify("user_123", { plan: "pro", company: "Acme" });
  yavio.conversion("purchase", { value: 99 });

  return { content: [{ type: "text", text: "Order placed." }] };
});
```

### Funnel Steps

Track progression through multi-step flows:

```typescript
server.registerTool("search", { inputSchema: { query: z.string() } }, async ({ query }) => {
  yavio.step("search_initiated", { queryLength: query.length });
  const results = await performSearch(query);
  yavio.step("results_found", { count: results.length });

  return { content: [{ type: "text", text: `Found ${results.length} results` }] };
});
```

### Custom Events and Conversions

```typescript
yavio.track("feature_used", { feature: "export", format: "pdf" });
yavio.conversion("subscription_upgrade", { value: 99, currency: "USD" });
```

### Widget SDK (React)

Track user interactions in ChatGPT App widgets:

```tsx
import { useYavio } from "@yavio/sdk/react";

function BookingWidget() {
  const yavio = useYavio();

  const handleBook = (booking) => {
    yavio.step("room_selected", { roomType: booking.type });
    yavio.conversion("booking_completed", { value: booking.price });
  };

  return <button onClick={() => handleBook(room)}>Book</button>;
}
```

The widget SDK auto-captures clicks, scrolls, form interactions, navigation, performance metrics, rage clicks, and more.

### Configuration

The SDK resolves config in this order:

1. **Code options** — `withYavio(server, { apiKey, endpoint })`
2. **Environment variables** — `YAVIO_API_KEY`, `YAVIO_ENDPOINT`
3. **Config file** — `.yaviorc.json` (auto-discovered via directory walk-up)
4. **No-op** — if no API key is found, the SDK does nothing (zero overhead)

## Self-Hosting Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | 2 cores | 4+ cores |
| RAM | 4 GB | 8+ GB |
| Disk | 20 GB | 100+ GB |
| Docker | v24+ | Latest stable |
| Docker Compose | v2.20+ | Latest stable |

## Tech Stack

| Layer | Technology |
|-------|------------|
| Monorepo | pnpm + Turborepo |
| Language | TypeScript (strict) |
| Ingestion | Fastify 5 |
| Dashboard | Next.js (App Router) |
| Analytics DB | ClickHouse |
| App DB | PostgreSQL + Drizzle ORM |
| Auth | NextAuth.js v5 |
| UI | shadcn/ui + Tailwind |
| Testing | Vitest |
| Linting | Biome |

## Project Structure

```
packages/
  shared/       Shared types, validation schemas, error codes
  db/           Drizzle ORM schema, ClickHouse client, migrations
  ingest/       Fastify ingestion API
  sdk/          Server SDK + React widget SDK
  dashboard/    Next.js analytics dashboard
  cli/          CLI for setup and platform management
  docs/         Documentation site (Fumadocs)
```

## Contributing

We welcome contributions! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a PR.

Join our [Discord](https://discord.gg/BprRh2fr) to discuss ideas and get help.

## Security

Found a vulnerability? Please report it responsibly — see [SECURITY.md](SECURITY.md). Do **not** open a public issue.

## License

MIT — see [LICENSE](LICENSE).

Copyright (c) 2026 Yavio GmbH
