# Contributing to Yavio

Thanks for your interest in contributing to Yavio! This guide covers everything you need to get started.

## Code of Conduct

By participating, you agree to uphold our [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting Started

### Prerequisites

- Node.js 20+ LTS
- Docker v24+ and docker-compose v2.20+
- pnpm (package manager)

### Development Setup

```bash
# Clone the repo
git clone https://github.com/yavio-ai/yavio-analytics.git
cd yavio-analytics

# Install dependencies
pnpm install

# Copy environment config
cp .env.example .env
# Fill in the required secrets (see comments in .env.example)

# Start infrastructure (PostgreSQL + ClickHouse)
docker compose up postgres clickhouse -d

# Run database migrations
pnpm db:migrate

# Start the development servers
pnpm dev
```

### Project Structure

```
packages/
  dashboard/    # Next.js 15 dashboard
  ingest/       # Fastify ingestion API
  sdk/          # @yavio/sdk (server + widget)
  cli/          # @yavio/cli
  shared/       # Shared types and validation
migrations/
  clickhouse/   # ClickHouse schema migrations
  postgres/     # PostgreSQL schema migrations
config/         # Docker service configs
specs/          # Technical specifications
```

## License

By contributing to Yavio, you agree that your contributions will be licensed under the [MIT License](LICENSE).

## How to Contribute

### Reporting Bugs

Open a [bug report issue](https://github.com/teamyavio/yavio/issues/new?template=bug_report.yml). Include:

- Steps to reproduce
- Expected vs. actual behavior
- Environment details (OS, Node version, Docker version)
- Logs or screenshots if applicable

### Suggesting Features

Open a [feature request issue](https://github.com/teamyavio/yavio/issues/new?template=feature_request.yml). Describe:

- The problem you're trying to solve
- Your proposed solution
- Alternatives you've considered

### Submitting Code

1. **Check existing issues** — look for an open issue or create one before starting work
2. **Fork the repo** and create a branch from `main`
3. **Follow the branch naming convention** (see below)
4. **Write tests** for any new functionality
5. **Run the checks** before pushing (see below)
6. **Open a pull request** using the PR template

## Branch Conventions

| Prefix | Use |
|--------|-----|
| `feat/` | New features (`feat/user-identification`) |
| `fix/` | Bug fixes (`fix/clickhouse-timeout`) |
| `docs/` | Documentation changes (`docs/sdk-quickstart`) |
| `refactor/` | Code refactoring (`refactor/event-pipeline`) |
| `test/` | Adding or updating tests (`test/ingestion-api`) |
| `chore/` | Maintenance tasks (`chore/update-deps`) |

## Code Style

The project uses [Biome](https://biomejs.dev/) for linting and formatting. Configuration is shared across all packages.

```bash
# Check formatting and lint
pnpm lint

# Auto-fix issues
pnpm lint:fix

# Format code
pnpm format
```

### Conventions

- **TypeScript** — strict mode, no `any` unless absolutely necessary
- **Imports** — use path aliases (`@/lib/...`) within packages
- **Naming** — `camelCase` for variables/functions, `PascalCase` for types/components, `SCREAMING_SNAKE_CASE` for constants
- **Tests** — colocate test files next to source (`*.test.ts`)

## Running Tests

```bash
# Run all tests
pnpm test

# Run tests for a specific package
pnpm --filter @yavio/sdk test
pnpm --filter dashboard test
pnpm --filter ingest test

# Run tests in watch mode
pnpm test:watch

# Run with coverage
pnpm test:coverage
```

All new code must maintain a **minimum of 80% test coverage**. PRs that drop coverage below this threshold will not be merged. Run `pnpm test:coverage` to verify before submitting.

## Pull Request Process

1. Fill out the PR template completely
2. Ensure all CI checks pass (lint, type check, tests)
3. Keep PRs focused — one feature or fix per PR
4. Update documentation if your change affects public APIs
5. A maintainer will review your PR and may request changes
6. Once approved, a maintainer will merge your PR

### Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(sdk): add .identify() method for user tracking
fix(ingest): handle malformed event payloads gracefully
docs: update self-hosting guide with TLS instructions
test(dashboard): add integration tests for funnel view
chore: update dependencies
```

Format: `type(scope): description`

- **type**: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`
- **scope** (optional): package name (`sdk`, `ingest`, `dashboard`, `cli`, `docs`)
- **description**: imperative mood, lowercase, no period

## Error Handling

All errors use the `YavioError` class from `@yavio/shared/errors`. Never throw a bare `Error` in service code.

### Creating Errors

```typescript
import { YavioError, ErrorCode } from "@yavio/shared/errors";

// Throw with a stable code, message, HTTP status, and optional metadata
throw new YavioError(
  ErrorCode.DASHBOARD.WORKSPACE_NOT_FOUND,
  "Workspace not found",
  404,
  { slug: "my-workspace" },
);
```

### Error Code Ranges

Each service owns a range of codes (defined in `packages/shared/src/error-codes.ts`):

| Range | Service | Object |
|-------|---------|--------|
| `YAVIO-1000` – `1999` | SDK | `ErrorCode.SDK` |
| `YAVIO-2000` – `2999` | Ingestion API | `ErrorCode.INGEST` |
| `YAVIO-3000` – `3999` | Dashboard | `ErrorCode.DASHBOARD` |
| `YAVIO-4000` – `4999` | Intelligence | `ErrorCode.INTELLIGENCE` |
| `YAVIO-5000` – `5999` | Database | `ErrorCode.DB` |
| `YAVIO-6000` – `6999` | CLI | `ErrorCode.CLI` |
| `YAVIO-7000` – `7999` | Infrastructure | `ErrorCode.INFRA` |

### Rules

- **Always use `YavioError`** with a code from the catalog — no bare `Error` in service code
- **Wrap unknown errors** — if you catch an unknown error, re-throw it as a `YavioError` (preserve if already one)
- **Include metadata** — pass context like variable names, slugs, or filenames in the `metadata` field
- **Codes are permanent** — never reuse or reassign an existing code
- **Adding a new code:** pick the next unused number in the service range, add it to `packages/shared/src/error-codes.ts`, and document it in `.specs/07_error-catalog.md`

See `.specs/07_error-catalog.md` for the full error specification.

## Development Tips

### Working with ClickHouse

```bash
# Connect to ClickHouse CLI
docker exec -it yavio-analytics-clickhouse-1 clickhouse-client

# Query events
SELECT * FROM yavio.events LIMIT 10;
```

### Working with PostgreSQL

```bash
# Connect to PostgreSQL
docker exec -it yavio-analytics-postgres-1 psql -U yavio_service -d yavio
```

### Running the Full Stack

```bash
# Start everything
docker compose up -d

# Check service health
docker compose ps

# View logs
docker compose logs -f ingest
docker compose logs -f dashboard
```

## Questions?

- Open a [discussion](https://github.com/yavio-ai/yavio-analytics/discussions)
- Join our [Discord](https://discord.gg/yavio)

Thank you for contributing!
