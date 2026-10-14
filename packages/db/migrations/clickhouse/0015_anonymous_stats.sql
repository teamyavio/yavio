-- Anonymous statistics tier (#85, steps 2 and 5).
--
-- Raw events are identifiable and kept 13 months (0013). Past that window only
-- these tables remain, kept indefinitely: daily grain, no identifiers, a fixed
-- vocabulary per dimension. They are filled by ingest's daily statistics job
-- (packages/ingest/src/stats), never by materialized views: an insert-triggered
-- MV counts retried batches twice, sees single insert blocks (so it cannot
-- count distinct individuals per cell), and cannot be backfilled without a gap
-- or a double count.
--
-- No TTL on any of them, deliberately (#85, round 3). The minimum cell size
-- (k = 5, folding small cells into '(other)') ships later; `individuals` is
-- stored per cell from the start so it can be applied to rows whose raw data
-- has expired by then.
--
-- Never stored here: uniq/uniqExact/HLL STATES. They keep (unsalted or fixed-
-- key) hashes of the ids, so anyone can test whether a known id is in a state.
-- Final numbers only.
--
-- Each table has a *_stage twin with the identical structure: the job fills
-- the stage for one month, then swaps it in with REPLACE PARTITION, which is
-- atomic and makes every run idempotent.

-- stats_daily: one table, several narrow slices instead of a cross-product of
-- every dimension. Dimensions a slice does not use are ''.
--   total       event_type
--   tool        event_type, event_name, status, error_category
--   client      event_type, platform, client_name
--   geo         event_type, country_code, language
--   conversion  event_name, conversion_currency
CREATE TABLE IF NOT EXISTS stats_daily (
  workspace_id        String,
  project_id          String,
  slice               LowCardinality(String),
  day                 Date,
  event_type          LowCardinality(String),
  event_name          String,
  status              LowCardinality(String),
  error_category      LowCardinality(String),
  platform            LowCardinality(String),
  client_name         String,
  country_code        LowCardinality(String),
  language            LowCardinality(String),
  conversion_currency LowCardinality(String),
  events              UInt64,
  -- Distinct people per cell (the #89 user key, else the session): exact,
  -- not additive across cells. The input for the minimum cell size.
  individuals         UInt64,
  latency_sum         Float64,
  latency_count       UInt64,
  conversions         UInt64,
  -- NULL below k once the minimum cell size ships.
  conversion_value    Nullable(Float64)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (workspace_id, project_id, slice, day, event_type, event_name, status, error_category,
          platform, client_name, country_code, language, conversion_currency);

CREATE TABLE IF NOT EXISTS stats_daily_stage AS stats_daily;

-- stats_users_daily: DAU, and WAU/MAU over the 7 and 30 days ending that day,
-- as plain numbers. The #89 user key (user_id, stitched subject_id), without
-- the session fallback, so the numbers do not jump where tier 1 ends.
CREATE TABLE IF NOT EXISTS stats_users_daily (
  workspace_id String,
  project_id   String,
  day          Date,
  dau          UInt64,
  wau          UInt64,
  mau          UInt64
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (workspace_id, project_id, day);

CREATE TABLE IF NOT EXISTS stats_users_daily_stage AS stats_users_daily;

-- stats_users_periods: distinct users per calendar week (Monday), month,
-- quarter and year, written once the period has closed. Partitioned by the
-- month the period ENDS in, so a quarter or a year is written when the job
-- processes its last month, while all of its raw data still exists.
CREATE TABLE IF NOT EXISTS stats_users_periods (
  workspace_id String,
  project_id   String,
  period       LowCardinality(String),
  period_start Date,
  period_end   Date,
  users        UInt64
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(period_end)
ORDER BY (workspace_id, project_id, period, period_start);

CREATE TABLE IF NOT EXISTS stats_users_periods_stage AS stats_users_periods;

-- stats_cohorts: users first seen in cohort_month who are active in
-- activity_month (offset 0-12). Partitioned by the activity month, so a month
-- is final once processed. "First seen" means within the raw-data window.
CREATE TABLE IF NOT EXISTS stats_cohorts (
  workspace_id   String,
  project_id     String,
  cohort_month   Date,
  activity_month Date,
  month_offset   UInt8,
  users          UInt64
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(activity_month)
ORDER BY (workspace_id, project_id, cohort_month, month_offset);

CREATE TABLE IF NOT EXISTS stats_cohorts_stage AS stats_cohorts;

-- Step 5, access. Row policies FIRST, then the grant: migration 0010's grants
-- are fail-closed, and a grant without policies would leak across tenants.
CREATE ROW POLICY IF NOT EXISTS workspace_isolation ON default.stats_daily
  USING workspace_id = getSetting('SQL_workspace_id') TO yavio_dashboard;
CREATE ROW POLICY IF NOT EXISTS project_isolation ON default.stats_daily
  AS RESTRICTIVE USING project_id = getSetting('SQL_project_id') TO yavio_dashboard;

CREATE ROW POLICY IF NOT EXISTS workspace_isolation ON default.stats_users_daily
  USING workspace_id = getSetting('SQL_workspace_id') TO yavio_dashboard;
CREATE ROW POLICY IF NOT EXISTS project_isolation ON default.stats_users_daily
  AS RESTRICTIVE USING project_id = getSetting('SQL_project_id') TO yavio_dashboard;

CREATE ROW POLICY IF NOT EXISTS workspace_isolation ON default.stats_users_periods
  USING workspace_id = getSetting('SQL_workspace_id') TO yavio_dashboard;
CREATE ROW POLICY IF NOT EXISTS project_isolation ON default.stats_users_periods
  AS RESTRICTIVE USING project_id = getSetting('SQL_project_id') TO yavio_dashboard;

CREATE ROW POLICY IF NOT EXISTS workspace_isolation ON default.stats_cohorts
  USING workspace_id = getSetting('SQL_workspace_id') TO yavio_dashboard;
CREATE ROW POLICY IF NOT EXISTS project_isolation ON default.stats_cohorts
  AS RESTRICTIVE USING project_id = getSetting('SQL_project_id') TO yavio_dashboard;

GRANT SELECT ON default.stats_daily TO yavio_dashboard;
GRANT SELECT ON default.stats_users_daily TO yavio_dashboard;
GRANT SELECT ON default.stats_users_periods TO yavio_dashboard;
GRANT SELECT ON default.stats_cohorts TO yavio_dashboard;

-- yavio_rollup: the statistics job's writer, and nothing else.
--   - reads events (all tenants: the job computes every project) and
--     tool_registry (event_name vocabulary);
--   - fills the stage tables (INSERT, TRUNCATE, and SELECT, which REPLACE
--     PARTITION ... FROM needs on its source);
--   - swaps a month into a stats table: REPLACE PARTITION needs INSERT and
--     ALTER DELETE on the target (checked on 26.8). It cannot read the stats
--     tables.
-- Same credential handling as yavio_eraser (0012): created unauthenticatable
-- (a digest whose preimage was never generated); migrate-clickhouse applies
-- CLICKHOUSE_ROLLUP_PASSWORD.
CREATE USER IF NOT EXISTS yavio_rollup
  IDENTIFIED WITH sha256_hash BY '322464e430fa3579779f1c4b82b59b559c50126dccad25f347635cc480d07a33';

GRANT SELECT ON default.events TO yavio_rollup;
GRANT SELECT ON default.tool_registry TO yavio_rollup;
GRANT SELECT, INSERT, TRUNCATE ON default.stats_daily_stage TO yavio_rollup;
GRANT SELECT, INSERT, TRUNCATE ON default.stats_users_daily_stage TO yavio_rollup;
GRANT SELECT, INSERT, TRUNCATE ON default.stats_users_periods_stage TO yavio_rollup;
GRANT SELECT, INSERT, TRUNCATE ON default.stats_cohorts_stage TO yavio_rollup;
GRANT INSERT, ALTER DELETE ON default.stats_daily TO yavio_rollup;
GRANT INSERT, ALTER DELETE ON default.stats_users_daily TO yavio_rollup;
GRANT INSERT, ALTER DELETE ON default.stats_users_periods TO yavio_rollup;
GRANT INSERT, ALTER DELETE ON default.stats_cohorts TO yavio_rollup;
