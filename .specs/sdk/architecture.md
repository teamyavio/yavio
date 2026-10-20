# SDK Package Architecture (`@yavio/sdk`)

The SDK ships as a single npm package with two entry points routed via the `package.json` exports field. This gives developers one install, one API key, and one mental model.

## Entry Points

| Import Path | Entry Point | Environment |
|-------------|-------------|-------------|
| `@yavio/sdk` | `./dist/index.js` (ESM), `./dist/index.cjs` (CommonJS) | Node.js (MCP server process) |
| `@yavio/sdk/react` | `./dist/react.js` (ESM), `./dist/react.cjs` (CommonJS) | Browser (ChatGPT widget iframe) |

## Exports Field

```json
// package.json (excerpt)
{
  "type": "module",
  "main": "./dist/index.cjs",
  "types": "./dist/index.d.cts",
  "typesVersions": { "*": { "react": ["./dist/react.d.cts"] } },
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    },
    "./react": {
      "import": { "types": "./dist/react.d.ts", "default": "./dist/react.js" },
      "require": { "types": "./dist/react.d.cts", "default": "./dist/react.cjs" }
    }
  },
  "peerDependencies": {
    "@modelcontextprotocol/sdk": ">=1.24.0",
    "react": ">=18.0.0",
    "react-dom": ">=18.0.0"
  }
}
```

Each condition carries its own declarations (0.4.2). With one `types` for both, TypeScript reads `index.d.ts` as ESM for a CommonJS app on `node16`/`nodenext`, whose `McpServer` is then the CommonJS class, and `withYavio(server)` does not compile. `main`, `types` and `typesVersions` serve `moduleResolution: node10`, which ignores `exports`.

`@yavio/shared` is not published. tsup bundles its code (`noExternal`) and, through a `paths` mapping in the declaration build, its types; before 0.4.2 `index.d.ts` imported `@yavio/shared/platform`, so `Platform` and `platformValues` were `any` or, with `skipLibCheck` off, the import failed. `scripts/check-package.mjs` (`check:package`, run in CI and before every publish) checks the packed tarball as an app consumes it.

## Directory Layout

```
@yavio/sdk/
├── src/
│   ├── server/              # Server entry point
│   │   ├── index.ts          # withYavio(), createYavio()
│   │   ├── proxy.ts          # McpServer proxy instrumentation
│   │   ├── context.ts        # AsyncLocalStorage + ctx injection
│   │   └── token.ts          # Widget config generation (API key + endpoint injection)
│   ├── react/               # React entry point
│   │   ├── index.ts          # useYavio() hook
│   │   ├── hook.ts           # Hook implementation + auto-config detection
│   │   └── transport.ts      # HTTP POST / sendBeacon to ingestion API
│   ├── core/                # Shared internals
│   │   ├── events.ts         # Event schema & types
│   │   ├── queue.ts          # Async batch queue (memory buffer → HTTP flush)
│   │   ├── pii.ts            # Best-effort PII redaction (regex-based, zero deps)
│   │   ├── platform.ts       # Platform detection
│   │   └── schema.ts         # Event validation
│   └── transport/           # HTTP transport to ingestion API
│       ├── http.ts           # HTTP batch transport (fetch + retry)
│       └── types.ts          # Transport interface
└── dist/                    # Built output
```

> **Note:** PII redaction uses a defense-in-depth strategy across two layers:
>
> 1. **SDK (best-effort, client-side)** — A lightweight, non-configurable pass strips common PII patterns (emails, IPs, credit card numbers, phone numbers) from event payloads before they leave the process. This minimises PII in transit and reduces exposure if the server-side layer has a bug. The implementation lives in `core/pii.ts` and uses fast regex matching with zero additional dependencies.
> 2. **Ingestion API (authoritative, server-side)** — The ingestion pipeline runs a full configurable scrub (`pipeline/pii.ts`) before writing to ClickHouse. This layer supports project-specific redaction rules (configured via the dashboard) and acts as the safety net — even if a developer uses an outdated SDK, PII is still caught here.

## Build Configuration

| Setting | Value | Notes |
|---------|-------|-------|
| Bundler | tsup | Fast, zero-config TypeScript bundler. Handles dual CJS/ESM. |
| TypeScript | 5.x, strict mode | `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` enabled. |
| Target | Node 20+ (server), ES2022 (react) | Node 20 is LTS. ES2022 covers ChatGPT/Claude runtimes. |
| External deps | @modelcontextprotocol/sdk | Peer dependency. No native modules — SDK is pure JS. |
| Testing | Vitest | Fast, native TypeScript support, good ESM handling. |
| Linting | Biome | All-in-one formatter + linter. Faster than ESLint + Prettier. |
