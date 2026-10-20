/**
 * Table/column reference returned by get_schema so the model can write
 * useful run_query SQL without guessing. Kept as a handwritten document —
 * it documents semantics, not just names.
 */
export const SCHEMA_DOC = `# Yavio analytics schema (ClickHouse SQL dialect)

Every query is hard-filtered by database row policies to the authorized
workspace AND to the single project_id you pass to run_query. You cannot see
another workspace, and you cannot see another project — including your own
other projects — in the same query.

That means a cross-project comparison is NOT possible in one query: to compare
projects, call run_query once per project_id and combine the results yourself.
A GROUP BY project_id returns exactly one group, not an error.

Always also filter on a timestamp range. Events are kept for 13 months.

## events — one row per SDK event (the main table)
Identity: event_id, workspace_id, project_id, trace_id, session_id
Classification:
- event_type (String): 'tool_call', 'connection', plus widget/conversion types
- event_name (Nullable String): tool name for tool_call events
- timestamp (DateTime64), platform (Nullable String: 'chatgpt', 'claude', ...), source (String)
User: user_id (Nullable), subject_id (Nullable — stable pseudonymous per-user id
from the platform), locale (Nullable, BCP-47 e.g. 'de-DE'), end_user_agent (Nullable)
Tool-call outcome: latency_ms (Nullable Float64), status ('success'/'error'),
error_category ('tool_error' = the handler returned isError: true, 'unknown' = the
handler threw; also 'auth'/'validation'/'timeout'/'rate_limit'/'server'),
error_message (PII-stripped, <= 500 chars), is_retry (UInt8, always 0 today)
Captured input/output (PII-stripped JSON strings): input_values, output_content,
input_keys, input_types, intent_signals (JSON with 'intent' and 'source' keys);
intent_context (Nullable: how the SDK advertised the intent 'context' parameter for
the tool — 'required', 'optional' (widget-invoked tool or required:false; the widget's
own calls land here and never carry an intent), 'none' (nothing advertised: intent
capture off, intent disabled for the tool, the tool has its own 'context' argument or
a schema the SDK cannot extend such as oneOf/anyOf/allOf or passthrough, or an unknown
tool); NULL = SDK < 0.4.0. Coverage = intents / ('required' or NULL) calls)
Tokens: tokens_in, tokens_out. Conversions: conversion_value, conversion_currency.
Geo: country_code (Nullable, ISO 3166-1 alpha-2), region (Nullable: state or
province as the platform names it, e.g. 'North Rhine-Westphalia' or 'State of
Berlin' — English, not ISO 3166-2; only set next to a country_code; NULL before
SDK 0.4.1). Both come from ChatGPT's request _meta and need the app's argument
capture on. Connection: protocol_version, client_name, client_version,
connection_duration_ms. SDK: sdk_version.
Widget: viewport_width/height, scroll_depth_pct, click_count, visible_duration_ms,
field_name, nav_from, nav_to, device_touch, device_pixel_ratio, load_time_ms.

Use JSONExtractString(intent_signals, 'intent') etc. for the JSON columns.

## tool_registry — registered tool definitions per project
project_id, tool_name, description, input_schema (JSON), registered_at, updated_at
NOTE: queries touching tool_registry are filtered to the project_id you pass
to run_query — rows of other projects are invisible.

## Anonymous statistics — kept indefinitely (filled daily by ingest)
Raw events are kept 13 months; these daily tables outlive them. No identifiers,
a fixed vocabulary per dimension. The current and previous month are
recomputed every day, older months are final. Use them for ranges older than
13 months; within the window, query events.

### stats_daily — one row per cell of a "slice"
workspace_id, project_id, slice, day (Date), event_type, event_name, status,
error_category, platform, client_name, country_code, language,
conversion_currency, events, individuals, latency_sum, latency_count,
conversions, conversion_value
- slice decides which dimensions are filled (the others are ''):
  'total' (event_type) | 'tool' (event_type, event_name, status,
  error_category) | 'client' (event_type, platform, client_name) |
  'geo' (event_type, country_code, language) | 'conversion' (event_name,
  conversion_currency). ALWAYS filter on one slice: summing across slices
  counts every event several times.
- event_name is a registered tool or a common event name; rare free-text
  names are '(other)'. platform outside the known list is 'other'.
- individuals = distinct people (or sessions where the app identifies no one)
  in that cell. NOT additive across days or cells.
- Average latency: sum(latency_sum) / sum(latency_count).

### stats_users_daily — day, dau, wau, mau (7/30 days ending that day)
### stats_users_periods — period ('week'|'month'|'quarter'|'year'), period_start,
period_end, users (distinct users in that closed calendar period)
### stats_cohorts — cohort_month, activity_month, month_offset (0-12), users
Users are counted by user_id, else the platform's subject_id, never by session.

## Rules for run_query
- Single SELECT (or WITH ... SELECT) statement only, against the tables
  above (the database user can read nothing else).
- No SETTINGS or FORMAT clauses, no comments, no quoted identifiers,
  no system tables, no table functions (incl. numbers()).
- Budgets are hard limits, NOT truncation: a query that would return more than
  10k rows, scan more than 50M rows, or run longer than 30s FAILS with a
  ClickHouse error instead of returning partial data. Aggregate and filter by
  timestamp rather than dumping raw rows.`;
