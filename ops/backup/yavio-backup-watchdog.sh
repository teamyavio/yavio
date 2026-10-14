#!/bin/bash
# Watchdog for the nightly backups (#92). Runs from root's crontab a few hours
# after them. If either backup has no "ok" line for today, it appends a FAIL
# line to backup.log — so a backup that never ran (cron gone, host down at the
# time) alerts exactly like one that failed. Alert on FAIL lines in backup.log
# (ops/backup/google-cloud-ops-agent.yaml shows one way to ship them).
# grep reads the file directly (no pipe), so pipefail cannot misfire here.
set -u
LOG=${YAVIO_BACKUP_DIR:-/var/backups/yavio}/backup.log
D=$(date -u +%Y%m%d)
NOW=$(date -u +%FT%TZ)
# No directory at all means no backup ever ran: still write the FAIL lines.
mkdir -p "$(dirname "$LOG")"
grep -q " ok yavio-control-plane-${D}T" "$LOG" 2>/dev/null \
  || echo "$NOW FAIL watchdog: no successful postgres backup today" >> "$LOG"
grep -q " ok clickhouse yavio-clickhouse-${D}T" "$LOG" 2>/dev/null \
  || echo "$NOW FAIL watchdog: no successful clickhouse backup today" >> "$LOG"
