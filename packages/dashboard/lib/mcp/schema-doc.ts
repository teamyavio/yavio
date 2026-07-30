/**
 * Table/column reference returned by get_schema so the model can write
 * useful run_query SQL without guessing. Kept as a handwritten document —
 * it documents semantics, not just names.
 */
export const SCHEMA_DOC = `# Yavio analytics schema (ClickHouse SQL dialect)

Every query is automatically filtered to the authorized workspace by
database-level row policies — you can only ever see your own data. Always
filter on project_id (get ids from list_projects) and a timestamp range.
Events are retained for 90 days.

## events — one row per SDK event (the main table)
Identity: event_id, workspace_id, project_id, trace_id, session_id
Classification:
- event_type (String): 'tool_call', 'connection', plus widget/conversion types
- event_name (Nullable String): tool name for tool_call events
- timestamp (DateTime64), platform (Nullable String: 'chatgpt', 'claude', ...), source (String)
User: user_id (Nullable), subject_id (Nullable — stable pseudonymous per-user id
from the platform), locale (Nullable, BCP-47 e.g. 'de-DE'), end_user_agent (Nullable)
Tool-call outcome: latency_ms (Nullable Float64), status ('success'/'error'),
error_category, error_message, is_retry (UInt8)
Captured input/output (PII-stripped JSON strings): input_values, output_content,
input_keys, input_types, intent_signals (JSON with 'intent' and 'source' keys)
Tokens: tokens_in, tokens_out. Conversions: conversion_value, conversion_currency.
Geo: country_code (Nullable). Connection: protocol_version, client_name,
client_version, connection_duration_ms. SDK: sdk_version.
Widget: viewport_width/height, scroll_depth_pct, click_count, visible_duration_ms,
field_name, nav_from, nav_to, device_touch, device_pixel_ratio, load_time_ms.

Use JSONExtractString(intent_signals, 'intent') etc. for the JSON columns.

## sessions_mv — one row per session (aggregated)
workspace_id, project_id, session_id, user_id, session_start, session_end,
platform, country_code, tool_count, invocation_count, event_count,
conversion_count, total_revenue, revenue_currency, duration_ms, has_widget, ttfi_ms

## users_mv — one row per identified user (aggregated)
workspace_id, project_id, user_id, first_seen, last_seen, total_events,
total_sessions, total_tool_calls, total_conversions, total_revenue,
revenue_currency, last_platform

## tool_registry — registered tool definitions per project
project_id, tool_name, description, input_schema (JSON), registered_at, updated_at
NOTE: queries touching tool_registry are filtered to the project_id you pass
to run_query — rows of other projects are invisible.

## Rules for run_query
- Single SELECT (or WITH ... SELECT) statement only, against the four tables
  above (the database user can read nothing else).
- No SETTINGS or FORMAT clauses, no comments, no quoted identifiers,
  no system tables, no table functions (incl. numbers()).
- Budgets are hard limits, NOT truncation: a query that would return more than
  10k rows, scan more than 50M rows, or run longer than 30s FAILS with a
  ClickHouse error instead of returning partial data. Aggregate and filter by
  timestamp rather than dumping raw rows.`;
