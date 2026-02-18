# CI/CD Pipeline

The Yavio platform is a monorepo with multiple independently deployable packages. The CI/CD pipeline uses **GitHub Actions** to lint, build, test, and publish every package on every change — while keeping feedback fast by only running jobs for packages that actually changed.

**Design principle:** The pipeline mirrors how a contributor works locally: `biome check` → `tsc --noEmit` → `vitest run` → `tsup` / `next build`. If it passes locally, it passes in CI. No CI-only magic. Self-hosters who fork the repo get the same pipeline with zero additional configuration.

## 1. Workflow Structure

```
.github/
  workflows/
    ci.yml                  # Lint, typecheck, build, test — runs on every PR and push to main
    release-npm.yml         # Publish @yavio/sdk and @yavio/cli to npm
    release-docker.yml      # Build and push dashboard + ingest Docker images to GHCR
    deploy-cloud.yml        # Deploy to Yavio Cloud staging/production (Cloud only)
    scheduled.yml           # Weekly load tests + dependency audit
  actions/
    setup/action.yml        # Composite action: checkout, Node.js, pnpm install, cache
    detect-changes/action.yml # Composite action: monorepo change detection
  PULL_REQUEST_TEMPLATE.md
  ISSUE_TEMPLATE/
    bug_report.yml
    feature_request.yml
```

## 2. CI Pipeline (`ci.yml`)

Runs on every pull request targeting `main` and on every push to `main`. This is the primary quality gate — PRs cannot merge until all required jobs pass.

### 2.1 Change Detection

The monorepo contains multiple packages with different dependency chains. Running every job for every change wastes time and compute. A change detection step at the top of the pipeline determines which packages are affected and skips unrelated jobs.

| Change Path | Affected Jobs |
|-------------|---------------|
| `packages/sdk/**` | sdk-lint, sdk-typecheck, sdk-test, sdk-build |
| `packages/ingest/**` | ingest-lint, ingest-typecheck, ingest-test, ingest-build, integration-test |
| `packages/dashboard/**` | dashboard-lint, dashboard-typecheck, dashboard-test, dashboard-build, integration-test |
| `packages/cli/**` | cli-lint, cli-typecheck, cli-test, cli-build |
| `packages/shared/**` | All jobs (shared types affect everything) |
| `packages/db/**` | ingest, dashboard, integration-test (shared database layer, includes migrations) |
| `docker-compose*.yml` | integration-test |
| `.github/**` | All jobs (CI config changes affect everything) |

Implementation uses `dorny/paths-filter` to produce boolean outputs per package, consumed by downstream jobs via `if: needs.detect.outputs.sdk == 'true'`.

### 2.2 Pipeline Stages

```
┌──────────────┐
│    Detect     │
│   Changes     │
└──────┬───────┘
       │
       ├──────────────────────────────────────────────────┐
       │                                                  │
       ▼                                                  ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  SDK         │  │  Ingest      │  │  Dashboard    │  │  CLI         │
│  lint+type   │  │  lint+type   │  │  lint+type    │  │  lint+type   │
│  test+build  │  │  test+build  │  │  test+build   │  │  test+build  │
└──────┬───────┘  └──────┬───────┘  └──────┬────────┘  └──────────────┘
       │                 │                 │
       └────────────┬────┘─────────────────┘
                    ▼
           ┌──────────────┐
           │  Integration  │
           │    Tests      │
           │ (ClickHouse + │
           │  PostgreSQL)  │
           └──────────────┘
```

All per-package jobs run in parallel. Integration tests run after all package builds succeed (they need the built artifacts).

### 2.3 Lint & Format

**Runner:** `ubuntu-latest`, Node.js 22

Runs Biome on the entire monorepo in a single pass. Biome is fast enough (~500ms for the full repo) that splitting per package adds more overhead than it saves.

```yaml
lint:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: ./.github/actions/setup
    - run: pnpm exec biome check .
```

**Failure mode:** Any formatting or lint violation fails the job. No auto-fix in CI — contributors run `pnpm exec biome check --write` locally.

### 2.4 Type Check

**Runner:** `ubuntu-latest`, Node.js 22

Runs `tsc --noEmit` per package in dependency order. The `shared` and `db` packages are built first since other packages depend on their type exports.

```yaml
typecheck:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: ./.github/actions/setup
    - run: pnpm --filter @yavio/shared typecheck
    - run: pnpm --filter @yavio/db typecheck
    - run: pnpm --filter @yavio/sdk typecheck
    - run: pnpm --filter @yavio/ingest typecheck
    - run: pnpm --filter @yavio/dashboard typecheck
    - run: pnpm --filter @yavio/cli typecheck
```

Each `package.json` defines a `typecheck` script: `"typecheck": "tsc --noEmit"`.

### 2.5 Unit Tests

**Runner:** `ubuntu-latest`, Node.js 22
**Framework:** Vitest

Per-package unit tests run in parallel. No external services required — unit tests mock all I/O boundaries (ClickHouse, PostgreSQL, HTTP).

```yaml
test-sdk:
  runs-on: ubuntu-latest
  if: needs.detect.outputs.sdk == 'true'
  steps:
    - uses: actions/checkout@v4
    - uses: ./.github/actions/setup
    - run: pnpm --filter @yavio/sdk test
```

Repeated for `ingest`, `dashboard`, and `cli` with their respective change detection gates.

**Coverage:** Vitest reports coverage via `--coverage`. Coverage reports are uploaded as PR comments using `davelosert/vitest-coverage-report-action`. No hard coverage thresholds enforced — coverage is informational, not a gate.

### 2.6 Build

**Runner:** `ubuntu-latest`, Node.js 22

Verifies that all packages build successfully. Build artifacts are uploaded for use by integration tests and release workflows.

| Package | Build Command | Output |
|---------|--------------|--------|
| `shared` | `tsup` | `dist/` (CJS + ESM type definitions) |
| `db` | `tsup` | `dist/` (CJS + ESM, Drizzle schema + clients) |
| `sdk` | `tsup` | `dist/` (CJS + ESM bundles + `.d.ts`) |
| `ingest` | `tsup` | `dist/` (CJS bundle) |
| `dashboard` | `next build` | `.next/` (standalone output) |
| `cli` | `tsup` | `dist/` (single executable ESM bundle) |

Build order respects dependency chain: `shared` / `db` → `sdk` / `ingest` / `cli` → `dashboard`.

### 2.7 Integration Tests

**Runner:** `ubuntu-latest`, Node.js 22
**Services:** ClickHouse 24.3 + PostgreSQL 16 (GitHub Actions service containers)

Integration tests validate the full data path: SDK → ingestion API → ClickHouse → dashboard query. They run against real databases, not mocks. See [testing.md](./testing.md) for the full test matrix.

```yaml
integration-test:
  runs-on: ubuntu-latest
  if: needs.detect.outputs.ingest == 'true' || needs.detect.outputs.dashboard == 'true' || needs.detect.outputs.migrations == 'true'
  services:
    postgres:
      image: postgres:16
      env:
        POSTGRES_DB: yavio_test
        POSTGRES_USER: yavio_service
        POSTGRES_PASSWORD: test
      ports:
        - 5432:5432
      options: >-
        --health-cmd "pg_isready -U yavio_service"
        --health-interval 5s
        --health-timeout 5s
        --health-retries 5
    clickhouse:
      image: clickhouse/clickhouse-server:24.3
      ports:
        - 8123:8123
      options: >-
        --health-cmd "clickhouse-client --query 'SELECT 1'"
        --health-interval 5s
        --health-timeout 5s
        --health-retries 5
  steps:
    - uses: actions/checkout@v4
    - uses: ./.github/actions/setup
    - run: pnpm run migrate
      env:
        DATABASE_URL: postgres://yavio_service:test@localhost:5432/yavio_test
        CLICKHOUSE_URL: http://localhost:8123
    - run: pnpm run test:integration
      env:
        DATABASE_URL: postgres://yavio_service:test@localhost:5432/yavio_test
        CLICKHOUSE_URL: http://localhost:8123
```

**Timeout:** 15 minutes. Integration tests that hang beyond this are killed.

### 2.8 Security Checks

Run on every PR. Validates that no secrets are committed and that PII redaction, authentication, and workspace isolation tests pass. See [testing.md §Security Tests](./testing.md) for the full matrix.

| Check | Tool | Trigger |
|-------|------|---------|
| Secret scanning | GitHub Advanced Security (built-in) | Every push |
| Dependency vulnerabilities | `pnpm audit --audit-level=high` | Every PR |
| PII redaction tests | Vitest (ingest test suite) | Every PR |
| Auth/isolation tests | Vitest (ingest + dashboard test suites) | Every PR |

## 3. Release Pipeline

Releases are triggered by pushing a version tag (`v*`). The release process is:

1. Contributor opens a PR bumping `version` in the relevant `package.json` files
2. PR merges to `main`
3. Maintainer creates and pushes a git tag: `git tag v1.2.0 && git push origin v1.2.0`
4. Tag push triggers the release workflows

### 3.1 npm Publish (`release-npm.yml`)

**Trigger:** Push of a tag matching `v*`

Publishes the SDK and CLI packages to the npm registry. Only runs when the tagged commit includes changes to publishable packages.

```yaml
release-npm:
  runs-on: ubuntu-latest
  permissions:
    contents: read
    id-token: write  # OIDC for npm provenance
  steps:
    - uses: actions/checkout@v4
    - uses: ./.github/actions/setup
    - run: pnpm --filter @yavio/shared build
    - run: pnpm --filter @yavio/sdk build
    - run: pnpm --filter @yavio/cli build
    - run: pnpm --filter @yavio/sdk publish --provenance --access public --no-git-checks
      env:
        NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
    - run: pnpm --filter @yavio/cli publish --provenance --access public --no-git-checks
      env:
        NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**npm provenance:** Uses OIDC (`id-token: write`) to sign packages with Sigstore provenance attestations. This lets consumers verify that a published package was built from a specific commit in CI, not from a developer's machine.

**Scoped packages:** `@yavio/sdk` and `@yavio/cli` are published with `--access public` since scoped packages default to restricted on npm.

### 3.2 Docker Publish (`release-docker.yml`)

**Trigger:** Push of a tag matching `v*`

Builds and pushes Docker images for the dashboard and ingestion API to **GitHub Container Registry** (GHCR). GHCR is free for public repositories and keeps images alongside the source code.

```yaml
release-docker:
  runs-on: ubuntu-latest
  permissions:
    contents: read
    packages: write  # Push to GHCR
  strategy:
    matrix:
      service: [dashboard, ingest]
  steps:
    - uses: actions/checkout@v4
    - uses: docker/setup-buildx-action@v3
    - uses: docker/login-action@v3
      with:
        registry: ghcr.io
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}
    - uses: docker/build-push-action@v6
      with:
        context: .
        file: packages/${{ matrix.service }}/Dockerfile
        push: true
        tags: |
          ghcr.io/yavio/${{ matrix.service }}:${{ github.ref_name }}
          ghcr.io/yavio/${{ matrix.service }}:latest
        cache-from: type=gha
        cache-to: type=gha,mode=max
        platforms: linux/amd64,linux/arm64
```

**Multi-arch builds:** Images are built for both `linux/amd64` and `linux/arm64`. ARM support is important for self-hosters running on Apple Silicon or ARM-based cloud instances (Graviton, Ampere).

**Image tags:**
- `ghcr.io/yavio/dashboard:v1.2.0` — immutable version tag
- `ghcr.io/yavio/dashboard:latest` — rolling tag for `docker-compose up` convenience
- `ghcr.io/yavio/ingest:v1.2.0` / `ghcr.io/yavio/ingest:latest` — same pattern

### 3.3 GitHub Release

After both npm and Docker publish succeed, a GitHub Release is created automatically using `softprops/action-gh-release`. The release body includes:

- Auto-generated changelog from conventional commits since the last tag
- Links to npm packages (`@yavio/sdk@x.y.z`, `@yavio/cli@x.y.z`)
- Links to Docker images on GHCR
- Upgrade instructions (if breaking changes)

### 3.4 Intelligence Service (Proprietary)

The intelligence service is published to a **private** container registry, not GHCR. Its CI/CD pipeline lives in a separate private repository and is out of scope for this spec. The pipeline structure mirrors the open-source services (lint → build → test → Docker push) but publishes to a private registry that requires a license key to pull.

## 4. Versioning

All open-source packages share a single version number. When any publishable package changes, the version is bumped in all `package.json` files simultaneously. This simplifies the mental model for contributors and consumers: version `1.2.0` of the SDK, CLI, dashboard, and ingestion API are always compatible with each other.

| Package | Versioned | Published To |
|---------|-----------|-------------|
| `@yavio/sdk` | Yes | npm |
| `@yavio/cli` | Yes | npm |
| `yavio/dashboard` | Yes | GHCR (Docker) |
| `yavio/ingest` | Yes | GHCR (Docker) |
| `@yavio/shared` | No (internal) | Not published |
| `@yavio/db` | No (internal) | Not published |

**Versioning scheme:** [Semantic Versioning 2.0.0](https://semver.org/).

- **Major:** Breaking changes to SDK public API, ingestion API contract, or Docker Compose configuration
- **Minor:** New features, new event types, new dashboard views, new CLI commands
- **Patch:** Bug fixes, performance improvements, documentation updates

**Commit convention:** [Conventional Commits](https://www.conventionalcommits.org/). Commit messages follow the format `type(scope): description`. The changelog is generated from these commits.

| Prefix | Meaning | Version Bump |
|--------|---------|-------------|
| `feat` | New feature | Minor |
| `fix` | Bug fix | Patch |
| `perf` | Performance improvement | Patch |
| `docs` | Documentation only | None (no release) |
| `chore` | Build, CI, tooling | None (no release) |
| `refactor` | Code change that neither fixes nor adds | None (no release) |
| `BREAKING CHANGE` | Footer or `!` suffix on type | Major |

## 5. Branch Strategy

| Branch | Purpose | CI Runs | Deploy Target |
|--------|---------|---------|---------------|
| `main` | Stable, tested, release-ready | Full CI pipeline | Staging (auto), Production (manual) |
| `feat/*` | Feature development | Full CI on PR | None |
| `fix/*` | Bug fixes | Full CI on PR | None |
| `release/*` | Release candidates (if needed for stabilization) | Full CI on PR | None |

**Merge method:** Squash merge for feature/fix branches. This keeps `main` history clean and makes changelog generation reliable (one commit = one feature/fix).

**Branch protection rules for `main`:**

| Rule | Setting |
|------|---------|
| Require pull request reviews | 1 approval minimum |
| Require status checks to pass | lint, typecheck, test-*, build-*, integration-test, security |
| Require branches to be up to date | Yes (linear history) |
| Require signed commits | No (reduces contributor friction; provenance is enforced at publish time) |
| Allow force push | No |
| Allow deletions | No |

## 6. Caching

CI speed is critical for contributor experience. The pipeline caches aggressively to avoid redundant work.

| Cache | Key | Scope | Typical Savings |
|-------|-----|-------|-----------------|
| pnpm dependencies | `hashFiles('**/pnpm-lock.yaml')` | Per-branch, fallback to `main` | 30–60s (avoids full `pnpm install`) |
| Next.js build cache | `.next/cache` | Per-branch | 30–90s (incremental builds) |
| Docker layer cache | GitHub Actions cache (GHA) | Cross-branch | 1–3 min (avoids rebuilding base layers) |
| Biome binary | `~/.cache/biome` | Global | 5s (avoids download) |

### 6.1 Setup Composite Action

The shared `.github/actions/setup/action.yml` composite action standardizes Node.js and pnpm setup across all jobs:

```yaml
# .github/actions/setup/action.yml
name: Setup
description: Checkout, install pnpm, Node.js, restore store cache, install dependencies
runs:
  using: composite
  steps:
    - uses: pnpm/action-setup@v4
      with:
        version: 10
    - uses: actions/setup-node@v4
      with:
        node-version: 22
        registry-url: https://registry.npmjs.org
        cache: 'pnpm'
    - run: pnpm install --frozen-lockfile
      shell: bash
```

## 7. Secret Management

### 7.1 Repository Secrets

| Secret | Used By | Purpose |
|--------|---------|---------|
| `NPM_TOKEN` | `release-npm.yml` | npm publish authentication. Scoped to `@yavio` org with `publish` permission only. |
| `GITHUB_TOKEN` | `release-docker.yml` | GHCR push authentication. Auto-provided by GitHub Actions with `packages: write` permission. |

### 7.2 Cloud Deployment Secrets (Yavio Cloud Only)

| Secret | Used By | Purpose |
|--------|---------|---------|
| `CLOUD_DEPLOY_KEY` | `deploy-cloud.yml` | SSH or API key for deploying to Yavio Cloud infrastructure |
| `SENTRY_AUTH_TOKEN` | `release-docker.yml` | Upload source maps to Sentry at build time (dashboard only) |

### 7.3 Security Rules

- **No secrets in logs.** All workflow steps use `::add-mask::` for dynamic secrets. GitHub Actions automatically masks repository secrets in logs.
- **Least privilege.** Each workflow declares the minimum `permissions` needed. The default `GITHUB_TOKEN` permission is set to `contents: read` at the repository level.
- **No secrets in PRs from forks.** Fork PRs do not have access to repository secrets. Integration tests that require secrets are skipped for fork PRs (they run on the merge commit to `main` instead).
- **OIDC where possible.** npm provenance uses OIDC instead of long-lived tokens. Docker push to GHCR uses the auto-provided `GITHUB_TOKEN`.

## 8. Cloud Deployment (`deploy-cloud.yml`)

This workflow is specific to Yavio's managed SaaS offering. Self-hosters and open-source contributors do not need this — they pull images from GHCR and run `docker-compose up`. See [deployment.md §9.2](./deployment.md#92-managed-saas-yavio-cloud) for the Cloud architecture.

### 8.1 Deployment Flow

```
Tag push (v*)
  │
  ├── release-npm.yml     (publishes SDK + CLI to npm)
  ├── release-docker.yml  (pushes images to GHCR)
  │
  └── deploy-cloud.yml    (waits for Docker images, then deploys)
        │
        ├── Deploy to Staging
        │     └── Run smoke tests against staging
        │
        └── Deploy to Production (requires manual approval)
              └── Run smoke tests against production
```

### 8.2 Staging

Automatic deployment on every tag push. Staging runs the same Docker images and infrastructure as production but with a separate database and a test dataset.

**Smoke tests:** After deployment, a lightweight test suite runs against the staging environment:

| Test | Assertion |
|------|-----------|
| Ingestion health | `GET https://staging-ingest.yavio.ai/health` returns 200 |
| Dashboard health | `GET https://staging.yavio.ai/api/health` returns 200 |
| Event ingestion | POST a test event → query ClickHouse → event exists |
| Dashboard login | Navigate to login page → page loads without errors |

### 8.3 Production

Production deployment requires **manual approval** via GitHub Actions environments. After staging smoke tests pass, a maintainer reviews the staging deployment and approves the production rollout.

| Step | Detail |
|------|--------|
| Approval gate | GitHub Actions environment `production` with required reviewers |
| Deployment | Same images as staging (immutable tags ensure identical artifacts) |
| Smoke tests | Same suite as staging, run against production endpoints |
| Rollback | Redeploy previous tag: `git tag v1.1.9-rollback && git push origin v1.1.9-rollback` triggers a new deployment with the previous image |

## 9. Scheduled Workflows (`scheduled.yml`)

| Schedule | Job | Purpose | Timeout |
|----------|-----|---------|---------|
| Weekly (Sunday 02:00 UTC) | `load-test` | Run k6 load tests against a dedicated load-test environment. See [testing.md §Load Tests](./testing.md). | 30 min |
| Daily (06:00 UTC) | `dependency-audit` | `pnpm audit --audit-level=high`. Opens a GitHub issue if vulnerabilities are found. | 5 min |
| Weekly (Monday 08:00 UTC) | `dependency-update` | Check for outdated dependencies. Opens a PR with updates if available (via Renovate or Dependabot). | 10 min |

### 9.1 Dependency Management

**Renovate** (preferred over Dependabot for monorepo support) is configured to:

- Group minor and patch updates into a single weekly PR
- Open separate PRs for major version bumps
- Auto-merge patch updates for dependencies with passing CI
- Pin Docker base image digests in Dockerfiles (for reproducible builds)
- Pin GitHub Actions versions to commit SHAs (for supply chain security)

## 10. PR Checks (Required to Merge)

These status checks must pass before a PR can merge to `main`:

| Check | Job | Blocking |
|-------|-----|----------|
| Lint + Format | `lint` | Yes |
| Type Check | `typecheck` | Yes |
| Unit Tests (per affected package) | `test-sdk`, `test-ingest`, `test-dashboard`, `test-cli` | Yes |
| Build (per affected package) | `build-sdk`, `build-ingest`, `build-dashboard`, `build-cli` | Yes |
| Integration Tests | `integration-test` | Yes |
| Security Checks | `security` | Yes |
| No secrets in committed files | GitHub secret scanning | Yes |
| Dependency audit | `pnpm audit` | Yes (high/critical only) |

**Note:** Jobs that are skipped by change detection (e.g., SDK tests when only dashboard files changed) count as passing. GitHub Actions reports skipped jobs as successful when used with `if:` conditions on required checks.

## 11. Contributor Experience

### 11.1 Local Reproduction

Contributors can run the full CI pipeline locally before pushing:

```bash
# Lint + format
pnpm exec biome check .

# Type check
pnpm turbo typecheck

# Unit tests
pnpm turbo test

# Build
pnpm turbo build

# Integration tests (requires Docker)
docker compose -f docker-compose.test.yml up -d
pnpm run test:integration
docker compose -f docker-compose.test.yml down
```

### 11.2 CI Feedback

- **PR comments:** Vitest coverage reports and build size comparisons are posted as PR comments
- **Annotations:** TypeScript and Biome errors appear as inline annotations on the PR diff
- **Failure logs:** Failed jobs link directly to the failing step with full output

### 11.3 `docker-compose.test.yml`

A minimal Compose file for running integration tests locally, matching the CI service containers:

```yaml
# docker-compose.test.yml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: yavio_test
      POSTGRES_USER: yavio_service
      POSTGRES_PASSWORD: test
    ports:
      - "5432:5432"
    tmpfs:
      - /var/lib/postgresql/data  # RAM-backed for speed

  clickhouse:
    image: clickhouse/clickhouse-server:24.3
    ports:
      - "8123:8123"
    tmpfs:
      - /var/lib/clickhouse  # RAM-backed for speed
```

`tmpfs` mounts keep test databases in RAM for fast iteration. Data is discarded when the containers stop.

## 12. Pipeline Timing Targets

| Stage | Target | Notes |
|-------|--------|-------|
| Change detection | < 10s | Git diff analysis |
| Lint + format | < 30s | Biome is fast |
| Type check (all packages) | < 60s | Parallel per package |
| Unit tests (all packages) | < 2 min | Vitest is fast; parallelized |
| Build (all packages) | < 3 min | tsup is fast; Next.js benefits from cache |
| Integration tests | < 5 min | Service container startup + migrations + test run |
| **Total PR feedback** | **< 8 min** | From push to green/red status |
| Docker build + push | < 5 min | Layer caching + BuildKit |
| npm publish | < 1 min | Pre-built artifacts |
| Cloud staging deploy | < 3 min | Image pull + rolling update |

## 13. Environment Variables

CI-specific environment variables. For application environment variables, see [deployment.md §9.1.4](./deployment.md#914-environment-variables).

| Variable | Scope | Description |
|----------|-------|-------------|
| `CI` | All jobs | Set to `true` automatically by GitHub Actions. Used by Vitest to disable watch mode and by Next.js to skip interactive prompts. |
| `NODE_ENV` | Build jobs | Set to `production` for release builds, `test` for test runs |
| `DATABASE_URL` | Integration tests | PostgreSQL connection string for test database |
| `CLICKHOUSE_URL` | Integration tests | ClickHouse HTTP endpoint for test instance |
| `NEXTAUTH_SECRET` | Integration tests | Static test value (not a real secret) |
| `NPM_TOKEN` | Release jobs | npm publish authentication (repository secret) |
| `SENTRY_AUTH_TOKEN` | Release jobs | Sentry source map upload (repository secret, Cloud only) |

## 14. Dependencies

GitHub Actions and third-party actions used by the pipeline:

| Action | Version | Purpose |
|--------|---------|---------|
| `actions/checkout` | v4 | Repository checkout |
| `pnpm/action-setup` | v4 | Install pnpm |
| `actions/setup-node` | v4 | Node.js setup with pnpm store caching |
| `actions/upload-artifact` | v4 | Upload build artifacts between jobs |
| `actions/download-artifact` | v4 | Download build artifacts between jobs |
| `docker/setup-buildx-action` | v3 | Docker Buildx for multi-arch builds |
| `docker/login-action` | v3 | GHCR authentication |
| `docker/build-push-action` | v6 | Docker image build and push with layer caching |
| `dorny/paths-filter` | v3 | Monorepo change detection |
| `softprops/action-gh-release` | v2 | GitHub Release creation |
| `davelosert/vitest-coverage-report-action` | v2 | Coverage report as PR comment |

All third-party actions are pinned to commit SHAs in the workflow files (not version tags) to prevent supply chain attacks via tag mutation.

## 15. Cross-References

| Topic | Spec |
|-------|------|
| Testing strategy and test matrix | [infrastructure/testing.md](./testing.md) |
| Docker Compose configuration | [infrastructure/deployment.md](./deployment.md) |
| Docker service layout | [infrastructure/platform-layout.md](./platform-layout.md) |
| Observability (logging, metrics, tracing) | [infrastructure/observability.md](./observability.md) |
| Implementation roadmap and phasing | [04_roadmap.md](../04_roadmap.md) |
| SDK build configuration | [sdk/architecture.md](../sdk/architecture.md) |
