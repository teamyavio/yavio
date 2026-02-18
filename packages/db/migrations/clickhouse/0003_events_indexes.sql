-- 0003_events_indexes.sql
-- Secondary indexes for common query patterns on the events table.

ALTER TABLE events ADD INDEX IF NOT EXISTS idx_trace_id trace_id TYPE bloom_filter GRANULARITY 4;
ALTER TABLE events ADD INDEX IF NOT EXISTS idx_session_id session_id TYPE bloom_filter GRANULARITY 4;
ALTER TABLE events ADD INDEX IF NOT EXISTS idx_event_name event_name TYPE bloom_filter GRANULARITY 4;
ALTER TABLE events ADD INDEX IF NOT EXISTS idx_platform platform TYPE set(10) GRANULARITY 4;
ALTER TABLE events ADD INDEX IF NOT EXISTS idx_status status TYPE set(5) GRANULARITY 4;
ALTER TABLE events ADD INDEX IF NOT EXISTS idx_user_id user_id TYPE bloom_filter GRANULARITY 4;
