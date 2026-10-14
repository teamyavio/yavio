#!/bin/bash
# Nightly logical backup of Yavio's Postgres (the control plane: accounts,
# workspaces, projects, API keys) running in Docker on this host (#92).
#
# Writes two files per run to $DIR, keeping the newest $KEEP of each:
#   yavio-control-plane-<ts>.sql.gz          pg_dump --clean --if-exists
#   yavio-control-plane-<ts>.globals.sql.gz  the cluster's roles, WITHOUT
#                                            passwords (pg_dump does not carry
#                                            roles; a restore into a new
#                                            cluster needs them first)
# Get them off the host — disk snapshots, or a copy elsewhere — and keep the
# retention promise in mind: see docs → Self-Hosting → Backups & Operations.
# The 28-day rule: KEEP days here plus however long the copies live elsewhere
# must stay within what you tell your users (Yavio Cloud: "up to 4 weeks").
#
# Runs from root's crontab (ops/backup/crontab.example). Every run appends
# "ok ..." or "FAIL ..." to $DIR/backup.log; alert on FAIL (the watchdog adds
# one when a run is missing).

set -euo pipefail

# The dump contains password hashes, API key hashes and OAuth tokens: root-only.
umask 077

DIR=${YAVIO_BACKUP_DIR:-/var/backups/yavio}
KEEP=${YAVIO_BACKUP_KEEP:-14}
CONTAINER=${YAVIO_PG_CONTAINER:-yavio-postgres-1}
DBUSER=${YAVIO_PG_USER:-yavio_service}
DBNAME=${YAVIO_PG_DB:-yavio}

mkdir -p "$DIR"
chmod 700 "$DIR"
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$DIR/yavio-control-plane-$TS.sql.gz"
GLOBALS="$DIR/yavio-control-plane-$TS.globals.sql.gz"
LOG="$DIR/backup.log"

fail() {
  echo "$(date -u +%FT%TZ) FAIL $*" >> "$LOG"
  rm -f "$OUT.tmp" "$GLOBALS.tmp"
  exit 1
}

# The container must be up; a dump of nothing is worse than no dump.
RUNNING=$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)
[ "$RUNNING" = "true" ] || fail "container $CONTAINER is not running"

docker exec "$CONTAINER" pg_dump -U "$DBUSER" -d "$DBNAME" --clean --if-exists \
  | gzip -9 > "$OUT.tmp" || fail "pg_dump failed"
docker exec "$CONTAINER" pg_dumpall -U "$DBUSER" --globals-only --no-role-passwords \
  | gzip -9 > "$GLOBALS.tmp" || fail "pg_dumpall --globals-only failed"

# Verify the archives are intact and contain what a restore needs, so a
# silently-empty dump can never masquerade as a good backup.
# grep -c, not grep -q: -q exits at the first match, gunzip gets SIGPIPE, and
# pipefail then fails a good dump. That failed every night for two months on
# Yavio Cloud once the dump outgrew the pipe buffer.
gzip -t "$OUT.tmp" || fail "gzip integrity check failed"
gunzip -c "$OUT.tmp" | grep -c "CREATE TABLE public.users" >/dev/null \
  || fail "dump missing expected tables"
gzip -t "$GLOBALS.tmp" || fail "globals gzip integrity check failed"
gunzip -c "$GLOBALS.tmp" | grep -c "CREATE ROLE yavio_app" >/dev/null \
  || fail "globals missing the yavio_app role"

mv "$GLOBALS.tmp" "$GLOBALS"
mv "$OUT.tmp" "$OUT"

# Keep the newest $KEEP of each.
ls -1t "$DIR"/yavio-control-plane-*Z.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
ls -1t "$DIR"/yavio-control-plane-*.globals.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "$(date -u +%FT%TZ) ok $(basename "$OUT") $(stat -c%s "$OUT") bytes" >> "$LOG"
