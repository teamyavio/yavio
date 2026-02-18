-- 0002_events_table.sql
-- Core analytics events table.
-- Engine: ReplacingMergeTree for at-least-once dedup on event_id.
-- Partitioned by month for efficient range queries and TTL-based retention.

CREATE TABLE IF NOT EXISTS events (
  -- Identity
  event_id        String,
  workspace_id    String,
  project_id      String,
  trace_id        String,
  session_id      String,

  -- Event classification
  event_type      LowCardinality(String),
  event_name      Nullable(String),
  timestamp       DateTime64(3, 'UTC'),
  platform        LowCardinality(Nullable(String)),
  source          LowCardinality(String),

  -- User identification (set by .identify())
  user_id         Nullable(String),
  user_traits     String DEFAULT '{}',

  -- Tool call fields
  latency_ms      Nullable(Float64),
  status          LowCardinality(Nullable(String)),
  error_category  LowCardinality(Nullable(String)),
  error_message   Nullable(String),
  is_retry        UInt8 DEFAULT 0,

  -- Input/Output capture (PII-stripped)
  input_keys      String DEFAULT '{}',
  input_types     String DEFAULT '{}',
  intent_signals  String DEFAULT '{}',

  -- Token estimation
  tokens_in       Nullable(UInt32),
  tokens_out      Nullable(UInt32),

  -- Conversion fields
  conversion_value    Nullable(Float64),
  conversion_currency LowCardinality(Nullable(String)),

  -- Widget fields
  viewport_width   Nullable(UInt16),
  viewport_height  Nullable(UInt16),

  -- Geographic
  country_code     LowCardinality(Nullable(String)),

  -- Connection/protocol fields
  protocol_version  Nullable(String),
  client_name       Nullable(String),
  client_version    Nullable(String),
  connection_duration_ms Nullable(Float64),

  -- Widget interaction fields
  scroll_depth_pct    Nullable(Float64),
  click_count         Nullable(UInt32),
  visible_duration_ms Nullable(Float64),
  field_name          Nullable(String),
  nav_from            Nullable(String),
  nav_to              Nullable(String),
  device_touch        Nullable(UInt8),
  device_pixel_ratio  Nullable(Float32),
  connection_type     LowCardinality(Nullable(String)),
  load_time_ms        Nullable(Float64),

  -- Funnel step ordering
  step_sequence     Nullable(UInt32),

  -- Metadata (JSON stored as String, PII-stripped)
  metadata          String DEFAULT '{}',

  -- Ingestion metadata
  sdk_version       Nullable(String),
  ingested_at       DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (workspace_id, project_id, event_type, timestamp, event_id)
TTL toDateTime(timestamp) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;
