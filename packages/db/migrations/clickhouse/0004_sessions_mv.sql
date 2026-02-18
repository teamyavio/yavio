-- 0004_sessions_mv.sql
-- Aggregated session summaries, auto-computed by ClickHouse.
-- Feeds the sessions analytics view in the dashboard.

CREATE MATERIALIZED VIEW IF NOT EXISTS sessions_mv
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(session_start)
ORDER BY (workspace_id, project_id, session_id)
AS SELECT
  workspace_id,
  project_id,
  session_id,
  anyLastIf(user_id, user_id IS NOT NULL) AS user_id,
  min(timestamp) AS session_start,
  max(timestamp) AS session_end,
  anyLast(platform) AS platform,
  anyLast(country_code) AS country_code,
  uniqExactIf(event_name, event_type = 'tool_call') AS tool_count,
  countIf(event_type = 'tool_call') AS invocation_count,
  count() AS event_count,
  countIf(event_type = 'conversion') AS conversion_count,
  sumIf(conversion_value, event_type = 'conversion') AS total_revenue,
  anyLastIf(conversion_currency, event_type = 'conversion') AS revenue_currency,
  dateDiff('millisecond', min(timestamp), max(timestamp)) AS duration_ms,
  maxIf(1, event_type = 'widget_render') AS has_widget,
  dateDiff('millisecond',
    minIf(timestamp, event_type = 'widget_render'),
    minIf(timestamp, event_type = 'widget_click')
  ) AS ttfi_ms
FROM events
GROUP BY workspace_id, project_id, session_id;
