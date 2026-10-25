/**
 * The dashboard's user key (keyedEvents() in lib/queries/users.ts, #89 and
 * #145) as one run_query statement: tool calls per user over the last 30
 * days, both maps bounded to the same window as the dashboard's windowed
 * counts (review round 1: run_query stops at 50M rows read, and unbounded
 * maps read 13 months). Exported so a test runs it through the SQL guard
 * and against ClickHouse.
 */
export const USER_KEY_SQL = `WITH session_map AS (
  SELECT session_id AS stitched_session,
         argMin(assumeNotNull(user_id), (timestamp, event_id)) AS session_user_id
  FROM events
  WHERE event_type = 'identify' AND user_id IS NOT NULL AND user_id != ''
    AND session_id != '' AND ifNull(session_source, '') != 'per_request'
    AND timestamp >= now() - INTERVAL 30 DAY
  GROUP BY stitched_session
),
subject_map AS (
  SELECT assumeNotNull(subject_id) AS stitched_subject,
         argMax(assumeNotNull(user_id), timestamp) AS mapped_user_id
  FROM events
  WHERE subject_id IS NOT NULL AND subject_id != ''
    AND user_id IS NOT NULL AND user_id != '' AND timestamp >= now() - INTERVAL 30 DAY
  GROUP BY stitched_subject
)
SELECT coalesce(nullIf(e.user_id, ''), nullIf(m.session_user_id, ''),
                nullIf(s.mapped_user_id, ''), nullIf(e.subject_id, '')) AS person,
       count() AS tool_calls
FROM events AS e
LEFT JOIN session_map AS m ON m.stitched_session = e.session_id
LEFT JOIN subject_map AS s ON s.stitched_subject = ifNull(e.subject_id, '')
WHERE e.event_type = 'tool_call' AND e.timestamp >= now() - INTERVAL 30 DAY
GROUP BY person
ORDER BY tool_calls DESC
LIMIT 100`;

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
session_source (Nullable): how the SDK derived session_id — 'mcp_session_id'
(the transport's Mcp-Session-Id), 'openai_session' (ChatGPT's conversation),
'vscode_conversation' (VS Code's conversation id), 'codex_thread' (the Codex
CLI's thread), 'custom' (the app's own sessionKey option), 'connection' (no
key, a non-HTTP transport such as stdio: one session per client process) or
'per_request' (a key-less HTTP call: this "session" is ONE CALL, not a
conversation — on any server since SDK 0.5.5; before 0.5.5 only on servers
that build a new MCP server per request, while a long-lived server reusing one
stateless transport put every key-less caller into one such session). Widget
events carry their server session's source too. NULL = SDK < 0.5.4 (server or
widget). Count sessions as uniqExactIf(session_id,
ifNull(session_source, '') != 'per_request') — what the dashboard's Sessions
KPI and the users list do; countIf(event_type = 'tool_call' AND
session_source = 'per_request') is the number of calls from clients that send
no session key. Paths, funnels and identify() are per session, so they are
empty or one call long for per_request traffic.
A 'connection' event is emitted at least once per session per SDK process (a
stateless fleet writes one per instance that served the conversation) — for
per_request traffic once per SDK process per client (platform, client name and
version, protocol version) instead — so never count connection rows: count
sessions as above, over any event type. client_name comes from the protocol
envelope, the initialize handshake or the request's User-Agent;
JSONExtractString(metadata, 'client_info_source') says which ('envelope',
'initialize', 'user_agent').
Widget: viewport_width/height, scroll_depth_pct, click_count, visible_duration_ms,
field_name, nav_from, nav_to, device_touch, device_pixel_ratio, load_time_ms.
Funnel steps: event_type 'step', event_name = the step, step_sequence (Nullable
UInt32): the SDK's counter per session PER PROCESS, starting at 1 again on every
server instance and every widget load. Never group by it: order a session's
steps by (timestamp, step_sequence, event_id), as the dashboard's funnels do.

Use JSONExtractString(intent_signals, 'intent') etc. for the JSON columns.

## Who a user is
identify() stamps user_id only on the events of the server process that called
it, from that call on: on a fleet of instances, and before the call, events of
the same conversation carry none. The dashboard counts one person per event as
coalesce(the event's own user_id, the FIRST user_id an 'identify' event gave its
session_id, the user_id last seen with its subject_id, subject_id) — never the
session itself. Once a session is identified, all its events count for that
user — except a per_request session (see session_source), which is never
mapped: it is one call, and before SDK 0.5.5 a server that reused one
stateless transport put every key-less caller into one such session. The same key as one query (tool calls per person over the last 30 days;
person NULL = calls without a known user; uniqExact(person) counts users):
${USER_KEY_SQL}
Keep both maps bounded to the query's window, as here and in the dashboard's
windowed counts: run_query stops at 50M rows read, counting every scan, and
unbounded maps read all 13 months. With bounded maps a session whose first
identify falls before the window goes to a later id inside it, if it has one.

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
  in that cell. NOT additive across days or cells. A per_request session (see
  session_source) is not one: such an event — server or widget — counts as an
  individual only through its user key. Widgets on SDKs before 0.5.4 send no
  session_source, so their rows count as before.
- events = rows, except in cells with event_type = 'connection', where it is
  the distinct sessions that connected that day, per_request ones left out:
  NOT additive across days.
- People (individuals, and the users tables below) are keyed as in "Who a
  user is"; a per_request session maps no one (see individuals above).
- Method break: the connection measure (#142), the session map of "Who a
  user is" (#145) and the per_request rule (#144) apply from the stats runs
  after the ingest deploy that shipped them (one deploy, 2026-10-24). The
  first run after that deploy recomputes the
  previous month too; months before keep counting connection rows (one per
  session per server process) and per-request sessions as individuals, and
  keep the older key without the session map, so their individuals are
  higher where sessions identify (the user plus the session, instead of one
  person) and their users can be slightly lower (a day on which a user was
  seen only through another instance's events of an identified
  conversation). A figure spanning them mixes the methods. Use
  uniqExactIf(session_id, ifNull(session_source, '') != 'per_request') over
  events for sessions whenever the raw data is still there.
- Average latency: sum(latency_sum) / sum(latency_count).

### stats_users_daily — day, dau, wau, mau (7/30 days ending that day)
### stats_users_periods — period ('week'|'month'|'quarter'|'year'), period_start,
period_end, users (distinct users in that closed calendar period)
### stats_cohorts — cohort_month, activity_month, month_offset (0-12), users
Users are counted by the key in "Who a user is", never by session.

## Rules for run_query
- Single SELECT (or WITH ... SELECT) statement only, against the tables
  above (the database user can read nothing else).
- No SETTINGS or FORMAT clauses, no comments, no quoted identifiers,
  no system tables, no table functions (incl. numbers()).
- Budgets are hard limits, NOT truncation: a query that would return more than
  10k rows, scan more than 50M rows, or run longer than 30s FAILS with a
  ClickHouse error instead of returning partial data. Aggregate and filter by
  timestamp rather than dumping raw rows.`;
