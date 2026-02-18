-- 0001_schema_migrations.sql
-- Migration tracking table for ClickHouse.
-- The migration runner checks this table to determine which migrations have been applied.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     String,
  applied_at  DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree()
ORDER BY version;
