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

NEXTAUTH_SECRET=$(generate_secret)
JWT_SECRET=$(generate_secret)
API_KEY_HASH_SECRET=$(generate_secret)
ENCRYPTION_KEY=$(generate_secret)

# Replace empty secret values in .env
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS sed requires -i ''
  sed -i '' "s|^NEXTAUTH_SECRET=.*|NEXTAUTH_SECRET=$NEXTAUTH_SECRET|" "$ENV_FILE"
  sed -i '' "s|^JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" "$ENV_FILE"
  sed -i '' "s|^API_KEY_HASH_SECRET=.*|API_KEY_HASH_SECRET=$API_KEY_HASH_SECRET|" "$ENV_FILE"
  sed -i '' "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$ENCRYPTION_KEY|" "$ENV_FILE"
else
  sed -i "s|^NEXTAUTH_SECRET=.*|NEXTAUTH_SECRET=$NEXTAUTH_SECRET|" "$ENV_FILE"
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" "$ENV_FILE"
  sed -i "s|^API_KEY_HASH_SECRET=.*|API_KEY_HASH_SECRET=$API_KEY_HASH_SECRET|" "$ENV_FILE"
  sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$ENCRYPTION_KEY|" "$ENV_FILE"
fi

echo "Created $ENV_FILE with generated secrets."
echo ""
echo "Next steps:"
echo "  docker compose up -d          # start databases"
echo "  pnpm install                   # install dependencies"
echo "  pnpm migrate                   # run database migrations"
echo "  pnpm turbo run dev             # start all services"
