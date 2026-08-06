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
# .env now concentrates the Postgres superuser password, the yavio_api and
# yavio_app passwords, and three ClickHouse credentials — plus two of them
# again inside DATABASE_URL / CLICKHOUSE_URL. It inherits .env.example's
# 0644 by default, which would let any local user read the entire datastore
# credential set and walk straight past the loopback port binding.
chmod 600 "$ENV_FILE"

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
CLICKHOUSE_ERASER_PASSWORD=$(generate_db_password)

# Replace values in .env. The trailing-comment form in .env.example
# (`KEY=value  # note`) is intentionally dropped for the secrets: a comment
# after a value is fragile to parse and has already caused one outage.
#
# The value travels through the ENVIRONMENT, never through argv. This used to be
# `sed -i "s|^${key}=.*|${key}=${value}|"`, which puts every secret on a command
# line — and a command line is world-readable through `ps` and
# /proc/<pid>/cmdline, while /proc/<pid>/environ is readable only by the owner.
# Passing them on argv handed any local user the entire datastore credential set
# and made the chmod 600 above pointless (CWE-214).
#
# Using awk instead of sed also removes the BSD/GNU `sed -i` split and the
# escaping question entirely: awk prints the value literally, so a `|`, `&` or
# backslash from some future generator cannot break the substitution or inject a
# second line. Today's values are base64/hex and cannot contain those — this is
# about not depending on that.
set_var() {
  local key="$1"
  # umask, because `mv` keeps the temp file's mode: created under the default
  # umask it would be world-readable and would silently widen .env.
  (
    umask 077
    SET_VAR_KEY="$key" SET_VAR_VALUE="$2" awk '
      BEGIN { key = ENVIRON["SET_VAR_KEY"]; value = ENVIRON["SET_VAR_VALUE"] }
      index($0, key "=") == 1 { print key "=" value; next }
      { print }
    ' "$ENV_FILE" > "$ENV_FILE.tmp"
  )
  mv "$ENV_FILE.tmp" "$ENV_FILE"
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
set_var CLICKHOUSE_ERASER_PASSWORD "$CLICKHOUSE_ERASER_PASSWORD"

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
