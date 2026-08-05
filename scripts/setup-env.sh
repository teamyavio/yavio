#!/usr/bin/env bash
# Generates .env from .env.example with random secrets.
# Usage: ./scripts/setup-env.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
EXAMPLE_FILE="$REPO_ROOT/.env.example"

if [ ! -f "$EXAMPLE_FILE" ]; then
  echo "Error: $EXAMPLE_FILE not found" >&2
  exit 1
fi

if [ -f "$ENV_FILE" ]; then
  echo ".env already exists. Overwrite? [y/N] "
  read -r answer
  if [[ ! "$answer" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

cp "$EXAMPLE_FILE" "$ENV_FILE"

# Generate random secrets
generate_secret() {
  openssl rand -base64 32
}

# Database passwords use a URL-safe alphabet: these end up inside a
# postgres://user:pass@host connection string, where base64's "+" and "/"
# would need percent-encoding.
generate_db_password() {
  openssl rand -hex 24
}

NEXTAUTH_SECRET=$(generate_secret)
JWT_SECRET=$(generate_secret)
API_KEY_HASH_SECRET=$(generate_secret)
ENCRYPTION_KEY=$(generate_secret)

# Datastore credentials are generated too. They previously kept the
# .env.example placeholder `yavio_dev`, which is published in a public repo —
# so every deployment that followed this script shared one well-known password
# for a Postgres superuser and for the ClickHouse default user.
POSTGRES_SERVICE_PASSWORD=$(generate_db_password)
POSTGRES_API_PASSWORD=$(generate_db_password)
POSTGRES_APP_PASSWORD=$(generate_db_password)
CLICKHOUSE_PASSWORD=$(generate_db_password)
CLICKHOUSE_INGEST_PASSWORD=$(generate_db_password)
CLICKHOUSE_DASHBOARD_PASSWORD=$(generate_db_password)

# Replace values in .env. The trailing-comment form in .env.example
# (`KEY=value  # note`) is intentionally dropped for the secrets: a comment
# after a value is fragile to parse and has already caused one outage.
set_var() {
  local key="$1" value="$2"
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  fi
}

set_var NEXTAUTH_SECRET "$NEXTAUTH_SECRET"
set_var JWT_SECRET "$JWT_SECRET"
set_var API_KEY_HASH_SECRET "$API_KEY_HASH_SECRET"
set_var ENCRYPTION_KEY "$ENCRYPTION_KEY"
set_var POSTGRES_SERVICE_PASSWORD "$POSTGRES_SERVICE_PASSWORD"
set_var POSTGRES_API_PASSWORD "$POSTGRES_API_PASSWORD"
set_var POSTGRES_APP_PASSWORD "$POSTGRES_APP_PASSWORD"
set_var CLICKHOUSE_PASSWORD "$CLICKHOUSE_PASSWORD"
set_var CLICKHOUSE_INGEST_PASSWORD "$CLICKHOUSE_INGEST_PASSWORD"
set_var CLICKHOUSE_DASHBOARD_PASSWORD "$CLICKHOUSE_DASHBOARD_PASSWORD"

# These two are host-side URLs used by scripts run OUTSIDE Docker (pnpm migrate
# reads them via --env-file). They embed a password, so randomising the password
# without rewriting them leaves the script's own "Next steps" unable to connect.
set_var DATABASE_URL "postgres://yavio_service:$POSTGRES_SERVICE_PASSWORD@localhost:5432/yavio"
set_var CLICKHOUSE_URL "http://default:$CLICKHOUSE_PASSWORD@localhost:8123"

echo "Created $ENV_FILE with generated secrets and datastore passwords."
echo ""
echo "Next steps:"
echo "  docker compose up -d          # start databases"
echo "  pnpm install                   # install dependencies"
echo "  pnpm migrate                   # run database migrations"
echo "  pnpm turbo run dev             # start all services"
