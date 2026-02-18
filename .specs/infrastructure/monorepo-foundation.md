# Monorepo Foundation

Sets up the build tooling, code quality tools, and package scaffolding that all subsequent phases (and the CI/CD pipeline) depend on.

## Prerequisites

- Phase 1 complete (Docker Compose, database schemas, `packages/db`)

## Tasks

| Task | Description |
|------|-------------|
| Add `turbo.json` | Define `build`, `typecheck`, `test`, `lint` pipelines with dependency graph. Root scripts (`pnpm turbo run build`, etc.) delegate to Turborepo. |
| Install Biome | Add `@biomejs/biome` as root devDep, create `biome.json` with lint + format rules. Verify `pnpm exec biome check .` passes on current code. |
| Install Vitest | Add `vitest` as root devDep, create root `vitest.config.ts` (or per-package configs). Each package gets a `test` script. |
| Install tsup | Add `tsup` as root devDep. Library packages (`shared`, `db`, `sdk`, `cli`, `ingest`) each get a `tsup.config.ts` and `build` script. |
| Scaffold `packages/shared` | Create `@yavio/shared` with `events.ts` (event schema & types) and `validation.ts` (shared Zod schemas). Exports via `package.json` exports field. |
| Per-package `tsconfig.json` | Each package gets a `tsconfig.json` extending `tsconfig.base.json` with correct `include`, `references`, and `paths`. |
| Per-package scripts | Every `package.json` gets standard scripts: `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `build` (`tsup` or `next build`), `lint` (`biome check .`). |
| Root `package.json` scripts | Add `lint`, `typecheck`, `test`, `build` scripts that run `turbo run <task>`. |
| Update `pnpm-workspace.yaml` | Already lists `packages/*` — verify all new packages are discovered. No changes expected. |

## Milestone

`pnpm turbo run build typecheck lint` succeeds from the repo root with zero errors. `pnpm test` runs Vitest across all packages (empty test suites pass).

## Dependency Graph

```
packages/shared  ←── packages/sdk
                 ←── packages/ingest
                 ←── packages/dashboard
                 ←── packages/cli

packages/db      ←── packages/ingest
                 ←── packages/dashboard
```

`shared` and `db` are internal packages (not published to npm). They must build before dependent packages can typecheck or build.
