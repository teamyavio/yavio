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
-- poll prunes by ingested_at itself and the timestamp bound is gone; an outer
-- 73 h bound on timestamp stays for the sort key (review round 7; the
-- partitions are monthly).
--
-- minmax: ingested_at grows with insert order, so each granule's range is
-- narrow and a "last 10 s" bound skips nearly every granule of the day.
-- GRANULARITY 1: one range per index granule (8192 rows).
--
-- ADD INDEX applies to new parts only. MATERIALIZE INDEX builds it for the
-- parts already there — a mutation that reads the one column and writes the
-- index files, no column rewrite. The statement returns once the mutation is
-- queued and the migration is recorded then; the mutation runs on in the
-- background. It does not wait (no mutations_sync): the migrator's client has
-- the library's 30 s request timeout, so on a large table a waiting statement
-- could time out with the mutation still running, leave the version
-- unrecorded, and a re-run would queue a second one (review round 7). Until
-- the mutation is done a live poll runs unpruned, as it did before round 4 —
-- correct, only slower; to see whether it is done:
--   SELECT is_done, parts_to_do FROM system.mutations
--   WHERE table = 'events' AND command LIKE '%idx_ingested_at%'
-- Deploy order: migrate before the dashboard that relies on it.

ALTER TABLE events ADD INDEX IF NOT EXISTS idx_ingested_at ingested_at TYPE minmax GRANULARITY 1;

ALTER TABLE events MATERIALIZE INDEX idx_ingested_at;
