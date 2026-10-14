-- Keep raw events for 13 months instead of 90 days (#85, step 1).
--
-- Thirteen months is the identifiable window: 12 months for a year-over-year
-- comparison plus the current one. Past it, only anonymous daily statistics
-- remain (#85, later steps). Until this migration, every day deleted another
-- day of history.
--
-- least(timestamp, ingested_at): timestamp is client-supplied. With the TTL on
-- timestamp alone, an event dated in the future would escape retention for as
-- long as that date lies ahead. ingested_at is set by the server, so the row
-- expires 13 months after collection at the latest.
--
-- toDateTime(): on 24.3 a TTL expression must be Date or DateTime; DateTime64
-- is only accepted from 25.6. The converted form keeps working after the
-- upgrade (#95), so this needs no second change.
--
-- Deletion is row-wise. ttl_only_drop_parts stays 0 (the default): with 1, a
-- monthly partition would only go once ALL its rows expired, overshooting 13
-- months by up to a month.
--
-- MODIFY TTL runs a MATERIALIZE TTL mutation over the existing parts; cheap at
-- the 90-day volume this starts from.

ALTER TABLE events
  MODIFY TTL least(toDateTime(timestamp), toDateTime(ingested_at)) + INTERVAL 13 MONTH;
