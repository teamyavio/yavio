-- 0005_users_mv.sql
-- Aggregated user-level summaries, auto-computed by ClickHouse.
-- Enables retention analysis, DAU/WAU/MAU, per-user funnels, and cohort breakdowns.
-- Only populated for sessions where .identify() was called.
--
-- allow_nullable_key is required because user_id is Nullable(String) in events.
-- The WHERE clause filters NULLs, but ClickHouse still infers Nullable for the key.

CREATE MATERIALIZED VIEW IF NOT EXISTS users_mv
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(first_seen)
ORDER BY (workspace_id, project_id, user_id)
SETTINGS allow_nullable_key = 1
AS SELECT
  workspace_id,
  project_id,
  user_id,
  min(timestamp) AS first_seen,
  max(timestamp) AS last_seen,
  count() AS total_events,
  uniq(session_id) AS total_sessions,
  countIf(event_type = 'tool_call') AS total_tool_calls,
  countIf(event_type = 'conversion') AS total_conversions,
  sumIf(conversion_value, event_type = 'conversion') AS total_revenue,
  anyLastIf(conversion_currency, event_type = 'conversion') AS revenue_currency,
  anyLast(user_traits) AS latest_traits,
  anyLast(platform) AS last_platform,
  anyLast(country_code) AS last_country
FROM events
WHERE user_id IS NOT NULL AND user_id != ''
GROUP BY workspace_id, project_id, user_id;
