-- Deduplicate retried inserts into events (#90).
--
-- The ingest batch writer retries a failed insert. When the first attempt had
-- in fact reached ClickHouse and only the response was lost, the retry stored
-- the batch a second time. ReplacingMergeTree collapses the copies only after
-- a merge, so every query without FINAL counted them twice until then.
--
-- The writer now sends one insert_deduplication_token per batch, the same on
-- every retry. A non-replicated MergeTree only deduplicates with a window
-- greater than 0 (the default is 0): the hashes of the last N inserted blocks
-- are kept, and a block whose token is among them is dropped.
--
-- Scope: retries of one batch by ingest. An SDK that times out and re-sends a
-- request ingest had already written lands in a different batch, with a
-- different token; ReplacingMergeTree still collapses those rows on merge
-- (same sort key, event_id included), and the #85 job reads FINAL with
-- LIMIT 1 BY event_id.

ALTER TABLE events MODIFY SETTING non_replicated_deduplication_window = 1000;
