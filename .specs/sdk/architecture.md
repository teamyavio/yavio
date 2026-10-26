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
  "files": ["dist", "react/package.json", "LICENSE", "README.md"],
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
    "@modelcontextprotocol/server": "^2.0.0",
    "react": ">=18.0.0",
    "react-dom": ">=18.0.0"
  },
  "peerDependenciesMeta": {
    "@modelcontextprotocol/sdk": { "optional": true },
    "@modelcontextprotocol/server": { "optional": true },
    "react": { "optional": true },
    "react-dom": { "optional": true }
  }
}
```

React is needed only for `@yavio/sdk/react`. The two MCP peers are both optional because an integration has one or the other (#133): MCP SDK v1 (`@modelcontextprotocol/sdk`) or v2 (`@modelcontextprotocol/server` and its family). The SDK imports neither at runtime — the wrapped server is typed by shape (`McpServerLike`) — so `tsup` lists both as externals only to be safe. See [per-request-servers.md](./per-request-servers.md).

Each condition carries its own declarations (0.4.2). With one `types` for both, TypeScript reads `index.d.ts` as ESM for a CommonJS app on `node16`/`nodenext`, whose `McpServer` is then the CommonJS class, and `withYavio(server)` does not compile. Tools that ignore `exports` (TypeScript's `moduleResolution: node10`, Jest before 28, webpack 4) find the root through `main` and `types`, and `@yavio/sdk/react` through `react/package.json`, a stub whose `main`, `module` and `types` point into `dist/`.

`@yavio/shared` is not published. tsup bundles its code (`noExternal`) and inlines its types; `tsconfig.build.json` maps `@yavio/shared` and `@yavio/shared/*` to `packages/shared/src` for both, so bundle and declarations come from the same files. Before 0.4.2 `index.d.ts` imported `@yavio/shared/platform`, so `Platform` and `platformValues` were `any` or, with `skipLibCheck` off, the import failed. `scripts/check-package.mjs` (`check:package`) checks the packed tarball as an app consumes it, in CI and in the release workflow before publishing (see `.specs/infrastructure/ci-cd.md`).

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
> 1. **SDK (best-effort, client-side)** — A lightweight, non-configurable pass strips common PII patterns (emails, IBANs, credit card numbers, dashed US SSNs, phone numbers; no IP addresses) from event payloads before they leave the process. This minimises PII in transit and reduces exposure if the server-side layer has a bug. `core/pii.ts` walks the payload; the string rules are `@yavio/shared/pii` (#182), shared with ingest and bundled into the package, so they add no runtime dependency. Its walk turns a shared, non-circular reference into `"[Circular]"` (#194).
> 2. **Ingestion API (authoritative, server-side)** — The ingestion pipeline strips every event again before writing to ClickHouse (`lib/pii-stripper.ts`: the SDK's rules plus spaced and bare SSNs, ITINs and US street addresses; not configurable, no per-project rules). It is the safety net for fields the SDK does not strip and for clients without the SDK, but it cannot restore what an outdated SDK already replaced.

## Build Configuration

| Setting | Value | Notes |
|---------|-------|-------|
| Bundler | tsup | Fast, zero-config TypeScript bundler. Handles dual CJS/ESM. |
| TypeScript | 5.x, strict mode | `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` enabled. |
| Target | Node 20+ (server), ES2022 (react) | Node 20 is LTS. ES2022 covers ChatGPT/Claude runtimes. |
| External deps | @modelcontextprotocol/sdk | Peer dependency. No native modules — SDK is pure JS. |
| Testing | Vitest | Fast, native TypeScript support, good ESM handling. |
| Linting | Biome | All-in-one formatter + linter. Faster than ESLint + Prettier. |
