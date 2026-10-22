-- 0021_events_ingested_at_index.sql (#148, review round 6)
-- A minmax skip index on ingested_at, the column the live feed tails.
--
-- ingested_at is outside the sort key (workspace_id, project_id, event_type,
-- timestamp, event_id), so a bound on it alone pruned nothing: every live
-- poll sorted the project's whole last day. Review round 4 worked around that
-- with a bound on timestamp — the sort key's fourth column — one hour before
-- the cursor. But ingest clamps a client timestamp to [now − 72 h, now + 5 min]
-- (event-normalizer.ts), so a host whose clock runs more than an hour slow had
-- every event stored and none of them ever shown live. With this index the
-- poll prunes by ingested_at itself and the timestamp bound is gone; the
-- 1-day bound stays as the outer limit (the partition).
--
-- minmax: ingested_at grows with insert order, so each granule's range is
-- narrow and a "last 10 s" bound skips nearly every granule of the day.
-- GRANULARITY 1: one range per index granule (8192 rows).
--
-- ADD INDEX applies to new parts only. MATERIALIZE INDEX builds it for the
-- parts already there — a mutation that reads the one column and writes the
-- index files, no column rewrite — and mutations_sync = 1 makes this statement
-- wait for it, so the migration is complete when it returns. Deploy order:
-- migrate before the dashboard that relies on it; until the mutation is done a
-- live poll runs unpruned, as it did before round 4.

ALTER TABLE events ADD INDEX IF NOT EXISTS idx_ingested_at ingested_at TYPE minmax GRANULARITY 1;

ALTER TABLE events MATERIALIZE INDEX idx_ingested_at SETTINGS mutations_sync = 1;
