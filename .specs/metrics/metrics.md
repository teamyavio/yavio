# Derived Metrics

All metrics computed at query time from captured events. Nothing in this file is stored as a separate row or column — each metric is a query over `events.md` data.

---

## Overview KPIs

| Metric | Computation | Dashboard View |
|--------|-------------|----------------|
| Total invocations | `COUNT(*) WHERE event_type = 'tool_call'` | Overview |
| Unique sessions | `COUNT(DISTINCT session_id)` | Overview |
| Error rate | `COUNT(tool_call WHERE status='error') / COUNT(tool_call)` | Overview, Errors |
| Avg latency | `AVG(latency_ms) WHERE event_type = 'tool_call'` | Overview |
| Invocations over time | `tool_call` events grouped by time bucket | Overview (line chart) |
| Platform breakdown | `tool_call` events grouped by `platform` | Overview (pie chart) |
| Locations | `tool_call` events grouped by `country_code`, and by `(country_code, region)` (#129). Users = the Users-page key (`keyedEvents()`: own `user_id`, the session's first identified user (#145), the subject's user, `subject_id`; both maps stitched within the range), counted per country and per region, never summed from regions. NULL country or region = Unknown; Unknown country listed last, one GROUPING SETS pass. Coverage = calls with a country / all calls — in practice only ChatGPT sends a location, and only with `capture.inputValues` on | Overview (table, countries expand to regions) |
| Top tools by invocation | `tool_call` events grouped by `event_name` ORDER BY count | Overview |
| Total conversions | `COUNT(*) WHERE event_type = 'conversion'` | Overview |
| Total revenue | `SUM(conversion_value) WHERE event_type = 'conversion'` | Overview |

## Business KPIs

| Metric | Computation | Dashboard View |
|--------|-------------|----------------|
| Session-to-conversion rate | `COUNT(sessions with conversion_count > 0) / COUNT(sessions)` | Overview |
| Widget engagement rate | Sessions with any `widget_click` or `widget_form_field` / sessions with `widget_render` | Overview |

## Tool Explorer Metrics

| Metric | Computation | Dashboard View |
|--------|-------------|----------------|
| Per-tool invocation count | `COUNT(*) WHERE event_type = 'tool_call' GROUP BY event_name` | Tool Explorer |
| Latency distribution | Histogram of `latency_ms` for selected tool | Tool Explorer |
| Error rate over time | Error ratio per time bucket for selected tool | Tool Explorer |
| Error category breakdown | `COUNT(*) GROUP BY error_category` for selected tool | Tool Explorer |
| Parameter fill rates | Frequency of each key in `input_keys` / total invocations | Tool Explorer |
| Top values per parameter | Most frequent values per input key from `metadata` | Tool Explorer |
| Most common parameter combinations | Frequent `input_keys` patterns | Tool Explorer |
| Avg response size | `AVG(response_size)` from `metadata` for selected tool | Tool Explorer |
| Content type breakdown | Distribution of text/image/resource from `metadata` | Tool Explorer |
| Zero-result rate | `COUNT(zero_result) / COUNT(tool_call)` for selected tool | Tool Explorer |
| Zero-result by input pattern | Zero-result events correlated to `input_keys` patterns | Tool Explorer |
| Tool discovery-to-invocation ratio | `COUNT(tool_call for tool X) / COUNT(resource_access listing tool X)` | Tool Explorer |

## Funnel Metrics

| Metric | Computation | Dashboard View |
|--------|-------------|----------------|
| Step progression | A session's `step` rows ranked by `(timestamp, step_sequence, event_id)` — `row_number()` over the session's steps before the range's end, deduplicated by `event_id` — then `uniqExact(session_id)` per (position, `event_name`) for the steps inside the range (#145). One conversation is one attempt however many SDK processes served it; `step_sequence` restarts per process and is only the tie-breaker. One process gives exactly the old per-`step_sequence` result. Conversions carry no `step_sequence` and stay out | Funnel View |
| Drop-off rates | `COUNT(sessions reaching position N+1) / COUNT(sessions reaching position N)`; the drop-off list holds the sessions whose last position is N, each as the trace of its last step | Funnel View |
| Example traces | Full event timeline for individual `trace_id`, ordered by `timestamp, step_sequence, event_id` | Funnel View |

## Error Metrics

| Metric | Computation | Dashboard View |
|--------|-------------|----------------|
| Error rate over time | Error ratio per time bucket | Errors |
| Category breakdown | `COUNT(*) GROUP BY error_category` | Errors |
| Per-tool error rates | Error ratio grouped by `event_name` | Errors |
| Error recovery / retry success | `COUNT(tool_call WHERE is_retry=1 AND status='success') / COUNT(tool_call WHERE is_retry=1)` | Errors |

## Timing Metrics

| Metric | Computation | Dashboard View |
|--------|-------------|----------------|
| Time-to-first-interaction (TTFI) | `MIN(widget_click.timestamp) - widget_render.timestamp` per trace | Overview, Funnel View |
| Time-to-first-tool-call | `MIN(tool_call.timestamp) - session.started_at` per session | Overview |
| Latency percentiles (p50/p95/p99) | Percentile calculation over `latency_ms` | Tool Explorer |

## Session Aggregates

Computed from `events` at query time, grouped by `session_id` (the `sessions_mv` materialized view was dropped, #89). There is no explicit "session close" event — sessions are implicit aggregates over all events sharing the same `session_id`. Session boundaries are defined by the MCP `initialize` handshake (see [server-sdk.md Section 3.7](../sdk/server-sdk.md#37-session-lifecycle)).

| Field | Computation |
|-------|-------------|
| tool_count | `COUNT(DISTINCT event_name) WHERE event_type = 'tool_call'` in session |
| invocation_count | `COUNT(*) WHERE event_type = 'tool_call'` in session |
| event_count | `COUNT(*)` in session |
| conversion_count | `COUNT(*) WHERE event_type = 'conversion'` in session |
| total_revenue | `SUM(conversion_value)` in session |
| duration_ms | `MAX(timestamp) - MIN(timestamp)` in session |
| has_widget | `1` if any `widget_render` event in session |
| ttfi_ms | `MIN(widget_click.timestamp) - widget_render.timestamp` in session |
