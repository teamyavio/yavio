# Project Telemetry & Adoption Metrics

This spec covers how Yavio measures its own adoption and usage — not the analytics events the platform captures for its users, but the signals that tell us how the open-source project and SDK are being used in the wild. This data informs roadmap prioritization, compatibility decisions, and growth tracking.

The SDK and self-hosted platform send **anonymous, opt-out telemetry** — privacy-preserving usage signals sent to `telemetry.yavio.ai`. This data informs version support decisions, compatibility targets, and feature prioritization.

## 1. Anonymous Telemetry

### 1.1 Consent Model

Telemetry is **enabled by default** and can be disabled at any time. This follows the same pattern as Next.js, Astro, and PostHog.

**How to disable:**

```bash
# CLI command (persists to .yaviorc.json or platform config)
yavio telemetry disable

# Environment variable (overrides config file)
YAVIO_TELEMETRY=false

# .yaviorc.json (SDK-level)
{ "telemetry": false }
```

**First-run notice:** The first time `withYavio()` initializes or `yavio up` runs, a one-time notice is printed to stdout:

```
Yavio collects anonymous usage data to improve the product.
This can be disabled at any time: yavio telemetry disable
Learn more: https://yavio.ai/docs/telemetry
```

The notice is printed once and never repeated (tracked via a flag in `.yaviorc.json` or platform config).

### 1.2 Privacy Guarantees

Telemetry is designed to be **anonymous and non-reversible**. The following rules are enforced at the code level and documented publicly:

| Rule | Implementation |
|------|---------------|
| No PII | No names, emails, IP addresses, or user-identifiable data |
| No project data | No project names, workspace names, tool names, or event content |
| No API keys | Only the key prefix format is reported (e.g., `yav_`), never the key itself |
| Anonymous instance ID | Generated via `crypto.randomUUID()` on first run, stored locally. Not derived from hardware, IP, or user identity. |
| No tracking across projects | Each `.yaviorc.json` gets its own instance ID. No cross-project correlation. |
| Minimal payload | Only the fields listed in §1.3 and §1.4 — nothing else |
| Open source | The telemetry code lives in the public repo. Anyone can audit exactly what is sent. |

### 1.3 SDK Telemetry

The SDK (`@yavio/sdk`) sends a single telemetry event once per session (on first `flush()` call, not on import). A "session" is one process lifecycle — a long-running MCP server sends one event on startup, not per request.

**Endpoint:** `POST https://telemetry.yavio.ai/v1/sdk`

**Payload:**

```json
{
  "instanceId": "550e8400-e29b-41d4-a716-446655440000",
  "sdkVersion": "1.2.0",
  "nodeVersion": "20.11.0",
  "os": "linux",
  "arch": "x64",
  "platform": "claude",
  "transport": "streamable-http",
  "features": ["identify", "step", "conversion"],
  "entrypoint": "server",
  "timestamp": "2026-03-15T10:00:00Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `instanceId` | string | Anonymous UUID, generated once per `.yaviorc.json` and stored locally |
| `sdkVersion` | string | `@yavio/sdk` package version |
| `nodeVersion` | string | Node.js major.minor.patch |
| `os` | string | `process.platform` — `linux`, `darwin`, `win32` |
| `arch` | string | `process.arch` — `x64`, `arm64` |
| `platform` | string | Detected MCP host: `chatgpt`, `claude`, `cursor`, `vscode`, `unknown` |
| `transport` | string | MCP transport: `stdio`, `sse`, `streamable-http`, `unknown` |
| `features` | string[] | SDK features used in this session: `identify`, `step`, `track`, `conversion`, `widget` |
| `entrypoint` | string | `server` or `react` — which SDK entry point was loaded |
| `timestamp` | string | ISO 8601 timestamp of the telemetry event |

**What is NOT included:**
- API key or endpoint URL
- Tool names, event content, or user data
- Event volume or batch sizes
- Error messages or stack traces

### 1.4 Self-Hosted Instance Telemetry

Self-hosted deployments send a daily heartbeat from the dashboard service. The heartbeat fires once every 24 hours (on dashboard startup and then on a 24-hour interval).

**Endpoint:** `POST https://telemetry.yavio.ai/v1/instance`

**Payload:**

```json
{
  "instanceId": "660e8400-e29b-41d4-a716-446655440001",
  "platformVersion": "1.3.0",
  "dashboardVersion": "1.3.0",
  "ingestVersion": "1.3.0",
  "clickhouseVersion": "24.3.1",
  "postgresVersion": "16.2",
  "dockerVersion": "27.0.1",
  "nodeVersion": "20.11.0",
  "os": "linux",
  "arch": "x64",
  "workspaceCount": 3,
  "projectCount": 7,
  "userCount": 12,
  "plan": "community",
  "uptime": 86400,
  "timestamp": "2026-03-15T10:00:00Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `instanceId` | string | Anonymous UUID, generated on first startup and persisted in PostgreSQL (`platform_config` table) |
| `platformVersion` | string | Yavio platform release version |
| `dashboardVersion` | string | `yavio/dashboard` image version |
| `ingestVersion` | string | `yavio/ingest` image version |
| `clickhouseVersion` | string | ClickHouse server version (from `SELECT version()`) |
| `postgresVersion` | string | PostgreSQL version (from `SHOW server_version`) |
| `dockerVersion` | string | Docker engine version (from health check metadata) |
| `nodeVersion` | string | Node.js version running the dashboard |
| `os` | string | Host OS platform |
| `arch` | string | Host CPU architecture |
| `workspaceCount` | number | Total number of workspaces (count, not names) |
| `projectCount` | number | Total number of projects (count, not names) |
| `userCount` | number | Total number of registered users (count, not identities) |
| `plan` | string | Tier: `community`, `cloud_free`, `cloud_pro`, `enterprise` |
| `uptime` | number | Dashboard process uptime in seconds |
| `timestamp` | string | ISO 8601 timestamp |

**What is NOT included:**
- Workspace or project names
- User emails or names
- API keys
- Event volume or analytics data
- IP address (the telemetry endpoint does not log client IPs)

### 1.5 Telemetry Backend

The telemetry endpoint at `telemetry.yavio.ai` is a minimal HTTP service that:

1. Accepts POST requests with the payloads defined above
2. Validates the schema (rejects unexpected fields)
3. Writes to a lightweight data store (e.g., ClickHouse on Yavio Cloud or a simple append-only database)
4. Does **not** log client IP addresses — the reverse proxy strips the `X-Forwarded-For` header before the request reaches the application

The telemetry data is used internally for:

- SDK version distribution (which versions are in the wild — informs deprecation decisions)
- Platform adoption (OS, architecture, Node.js version — informs compatibility targets)
- Feature usage (which SDK methods are actually used — informs roadmap prioritization)
- Self-hosted instance health (version currency, cluster sizes — informs upgrade communications)

### 1.6 Transport & Reliability

| Property | Value | Rationale |
|----------|-------|-----------|
| Protocol | HTTPS POST | Simple, firewall-friendly, no persistent connection |
| Timeout | 3 seconds | Telemetry must never slow down the SDK or dashboard |
| Retry | None | If the request fails, it is silently dropped. Telemetry is best-effort. |
| Payload size | < 1 KB | Minimal bandwidth cost |
| Frequency | SDK: once per process lifetime. Instance: once per 24 hours. | Negligible network overhead |

> **Zero-impact guarantee:** Telemetry runs in a detached async context (`fetch` with no `await` on the response). A network failure, DNS timeout, or unreachable endpoint has zero effect on SDK or platform behavior. If `telemetry.yavio.ai` is down, nothing happens.

### 1.7 CLI Commands

| Command | Description |
|---------|-------------|
| `yavio telemetry status` | Show current telemetry status (enabled/disabled) and instance ID |
| `yavio telemetry disable` | Disable telemetry. Persists to config. Prints confirmation. |
| `yavio telemetry enable` | Re-enable telemetry. |

```
$ yavio telemetry status

Telemetry: enabled
Instance ID: 550e8400-e29b-41d4-a716-446655440000
Learn more: https://yavio.ai/docs/telemetry

$ yavio telemetry disable

✓ Telemetry disabled. No data will be sent.
  Re-enable anytime: yavio telemetry enable
```

### 1.8 Environment Variable

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `YAVIO_TELEMETRY` | No | `true` | Set to `false` to disable all anonymous telemetry. Overrides config file. |

## 2. Telemetry Documentation

A public documentation page at `https://yavio.ai/docs/telemetry` must be maintained alongside this spec. It covers:

1. **What data is collected** — full field list, with examples
2. **What data is NOT collected** — explicit privacy guarantees
3. **How to opt out** — all three methods (CLI, env var, config file)
4. **Why we collect it** — how the data is used (version support decisions, roadmap prioritization)
5. **Source code link** — direct link to the telemetry module in the public repo so anyone can audit the implementation
