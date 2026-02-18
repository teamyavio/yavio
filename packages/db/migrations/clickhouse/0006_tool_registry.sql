-- 0006_tool_registry.sql
-- Tool registry table.
-- Stores discovered tool definitions per project.
-- ReplacingMergeTree deduplicates on (project_id, tool_name) keeping the latest updated_at.

CREATE TABLE IF NOT EXISTS tool_registry (
  project_id    String,
  tool_name     String,
  description   Nullable(String),
  input_schema  String DEFAULT '{}',
  registered_at DateTime64(3, 'UTC'),
  updated_at    DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (project_id, tool_name);
