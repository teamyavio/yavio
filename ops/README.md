# ops/

Host-side files for running Yavio with Docker Compose. They are not used by
the containers; install them on the host. What each does, how to install it,
and the retention periods they implement: docs → Self-Hosting →
Backups & Operations (`packages/docs/content/docs/04-self-hosting/06-operations.mdx`).

| File | Install to |
|---|---|
| `backup/yavio-pg-backup.sh` | `/usr/local/bin/`, run from root's crontab |
| `backup/yavio-clickhouse-backup.sh` | `/usr/local/bin/`, run from root's crontab |
| `backup/yavio-backup-watchdog.sh` | `/usr/local/bin/`, run from root's crontab |
| `backup/crontab.example` | root's crontab |
| `backup/google-cloud-ops-agent.yaml` | example: ship `backup.log` to alerting on Google Cloud |
| `host/docker-daemon.json` | `/etc/docker/daemon.json` (merge), then restart Docker |
| `host/journald-yavio.conf` | `/etc/systemd/journald.conf.d/yavio.conf` |

**The 28-day rule.** Yavio Cloud tells customers that erased data can remain
in backups for up to 4 weeks. The dumps on the host (14 days) plus the disk
snapshots that contain them (14 days) stay within that. Any change to either
retention must keep the sum within 28 days, or the statement changes too.
