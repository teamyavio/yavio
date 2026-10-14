-- Per-project retention (#93): ingest's statistics job deletes the raw events
-- of projects that keep less than the platform's 13 months, once a day and
-- only after that day's aggregation succeeded. It runs as yavio_rollup, which
-- therefore needs ALTER DELETE on events — and still nothing on other tables
-- beyond what 0015 granted.
GRANT ALTER DELETE ON default.events TO yavio_rollup;
