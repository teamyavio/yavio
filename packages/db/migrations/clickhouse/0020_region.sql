-- 0020_region.sql (#128)
-- The end user's state or province, as the platform names it. ChatGPT relays
-- it in _meta["openai/userLocation"].region as an English, IP-derived name
-- ("North Rhine-Westphalia", "State of Berlin"), not an ISO 3166-2 code, and
-- not on every call. The SDK sends it with capture.geo true or "region"
-- (#127); ingest keeps a well-formed name next to a valid country_code and
-- sets anything else to NULL (event-normalizer.ts).
--
-- NULL: no region sent, an SDK before 0.4.1, or a value that failed the check.
-- No backfill: apps on geo: true already have the name in input_values._meta.
--
-- Raw events only. The anonymous tier (stats_daily) has no region: a region
-- cell is far smaller than a country cell, and stats_daily has no TTL, so it
-- waits for the minimum cell size (#85). The 13-month TTL (0013) and the
-- erasure worker cover this column like every other one on events.

ALTER TABLE events ADD COLUMN IF NOT EXISTS region LowCardinality(Nullable(String));
