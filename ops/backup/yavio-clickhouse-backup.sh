#!/bin/bash
# Nightly backup of Yavio's ClickHouse analytics database (the event store), #92.
#
# Uses ClickHouse's native BACKUP command, which captures schema + data for every
# table in `default`, including materialized views and their .inner_id.* tables,
# as one consistent snapshot. A per-table SELECT dump would NOT restore the
# materialized views correctly.
#
# It also captures the access entities: Yavio's users (yavio_ingest,
# yavio_dashboard, ...), their grants and the row policies. They live outside
# `default`, and default.schema_migrations records the migrations that created
# them — so after a restore onto a NEW server without them, migrate sees
# nothing pending and cannot recreate them. Users are stored with their
# password hashes; migrate sets the passwords from .env again.
#
# Written to $DIR (default /var/backups/yavio/clickhouse), keeping the newest
# $KEEP. The archive is moved OUT of the ClickHouse data volume afterwards, so
# backups do not inflate the volume (and every snapshot of it). Get it off the
# host, and mind the 28-day rule in yavio-pg-backup.sh.
#
# BACKUP ... TO File() writes below the server's backups.allowed_path, which
# the image's default config.xml sets to /var/lib/clickhouse/backups.
#
# Restore: docs → Self-Hosting → Backups & Operations.
#
# Runs from root's crontab (ops/backup/crontab.example) and logs "ok ..." or
# "FAIL clickhouse ..." to backup.log next to the Postgres backup's lines.
# clickhouse-client inside the container authenticates as the image's default
# user; with a password set, pass it via YAVIO_CH_PASSWORD.

set -euo pipefail

# Event data is customer analytics — root-only.
umask 077

BASE=${YAVIO_BACKUP_DIR:-/var/backups/yavio}
DIR=$BASE/clickhouse
KEEP=${YAVIO_BACKUP_KEEP:-14}
CONTAINER=${YAVIO_CH_CONTAINER:-yavio-clickhouse-1}
INNER=/var/lib/clickhouse/backups

mkdir -p "$DIR"
chmod 700 "$DIR"
TS=$(date -u +%Y%m%dT%H%M%SZ)
NAME="yavio-clickhouse-$TS.zip"
OUT="$DIR/$NAME"
LOG=$BASE/backup.log

# Note: stderr is deliberately NOT merged into command substitutions here —
# doing so captures `set -x` trace lines when debugging and corrupts the parse.
ch() {
  if [ -n "${YAVIO_CH_PASSWORD:-}" ]; then
    docker exec "$CONTAINER" clickhouse-client --password "$YAVIO_CH_PASSWORD" "$@" 2>/dev/null
  else
    docker exec "$CONTAINER" clickhouse-client "$@" 2>/dev/null
  fi
}

fail() {
  echo "$(date -u +%FT%TZ) FAIL clickhouse $*" >> "$LOG"
  docker exec "$CONTAINER" rm -f "$INNER/$NAME" 2>/dev/null || true
  exit 1
}

RUNNING=$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)
[ "$RUNNING" = "true" ] || fail "container $CONTAINER is not running"

# Row count before, so we can prove the backup captured a non-empty database.
ROWS_BEFORE=$(ch -q "SELECT count() FROM default.events" 2>/dev/null | tr -d '[:space:]')
[ -n "$ROWS_BEFORE" ] || fail "could not read events row count"

# Native BACKUP — one consistent archive for the whole database.
# NB: no `grep -q` in a pipeline — it exits early, SIGPIPEs the producer, and
# `set -o pipefail` then fails a pipeline that actually succeeded.
ACCESS="TABLE system.users, TABLE system.roles, TABLE system.row_policies, TABLE system.settings_profiles, TABLE system.quotas"
BACKUP_OUT=$(ch -q "BACKUP DATABASE default, $ACCESS TO File('$INNER/$NAME')" || true)
case "$BACKUP_OUT" in *BACKUP_CREATED*) ;; *) fail "BACKUP did not report BACKUP_CREATED: $BACKUP_OUT" ;; esac

# Verify using ClickHouse's own accounting rather than inspecting the zip:
# authoritative, and needs no external tooling on the host.
FILES=$(ch -q "SELECT num_files FROM system.backups WHERE name LIKE '%$NAME%' ORDER BY start_time DESC LIMIT 1" | tr -d '[:space:]')
[ -n "$FILES" ] && [ "$FILES" -gt 0 ] 2>/dev/null || fail "backup reported $FILES files"

# Move it out of the ClickHouse volume so snapshots don't carry backups-of-backups.
# Streamed rather than `docker cp`, which cannot read a tmpfs-mounted data dir.
docker exec "$CONTAINER" cat "$INNER/$NAME" > "$OUT" || fail "copying the archive out failed"
docker exec "$CONTAINER" rm -f "$INNER/$NAME" 2>/dev/null || true
chmod 600 "$OUT"

SIZE=$(stat -c%s "$OUT")
[ "$SIZE" -gt 1024 ] || fail "archive suspiciously small (${SIZE} bytes)"

# Structural check only if unzip is present — never let a missing tool fail a good backup.
if command -v unzip >/dev/null 2>&1; then
  unzip -t "$OUT" >/dev/null 2>&1 || fail "archive failed integrity check"
  LISTING=$(unzip -l "$OUT" 2>/dev/null || true)
  case "$LISTING" in *metadata/default/events.sql*) ;; *) fail "archive is missing metadata/default/events.sql" ;; esac
  case "$LISTING" in *data/system/users/*) ;; *) fail "archive is missing the users" ;; esac
  case "$LISTING" in *data/system/row_policies/*) ;; *) fail "archive is missing the row policies" ;; esac
fi

# Keep the newest $KEEP archives.
ls -1t "$DIR"/yavio-clickhouse-*.zip 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "$(date -u +%FT%TZ) ok clickhouse $NAME ${SIZE} bytes ${FILES} files ${ROWS_BEFORE} events" >> "$LOG"
