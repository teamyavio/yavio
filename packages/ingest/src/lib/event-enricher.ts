import type { BaseEvent } from "@yavio/shared/events";
import type { AuthContext } from "../types.js";

/**
 * A validated event with its tenant columns, as the batch writer inserts
 * it. No `ingested_at`: the column's DEFAULT (`now64(3)`, migration 0002)
 * stamps it when ClickHouse stores the row — the batch writer may insert
 * seconds after ingest received the batch (its 1 s flush, then retries that
 * each wait out the failed insert's own duration), and the live feed tails
 * `ingested_at` with a 10 s overlap, so a value stamped on receipt could
 * become visible after the window had moved past it and the row was never
 * shown; stamped at insert, `ingested_at` is monotonic with visibility and
 * on ClickHouse's own clock (#148 review round 5).
 */
export interface EnrichedEvent extends Record<string, unknown> {
  workspace_id: string;
  project_id: string;
}

/**
 * Every column of `events` ingest writes, with its type as ClickHouse
 * reports it (system.columns): the fields of every event type of the schema
 * (@yavio/shared/events) except tool_discovery's own, which go to
 * tool_registry (tool-registry.ts), plus the tenant columns. Checked at
 * startup (schema-guard.ts): a missing column or another type stops ingest,
 * because ClickHouse would silently skip a field it has no column for
 * (input_format_skip_unknown_fields) or refuse every row. Kept in step with
 * the schema by event-enricher.test.ts and with the migrations by
 * integration/startup-shutdown.test.ts.
 */
export const EVENTS_COLUMNS: Readonly<Record<string, string>> = {
  event_id: "String",
  workspace_id: "String",
  project_id: "String",
  trace_id: "String",
  session_id: "String",
  event_type: "LowCardinality(String)",
  event_name: "Nullable(String)",
  timestamp: "DateTime64(3, 'UTC')",
  platform: "LowCardinality(Nullable(String))",
  source: "LowCardinality(String)",
  user_id: "Nullable(String)",
  user_traits: "String",
  latency_ms: "Nullable(Float64)",
  status: "LowCardinality(Nullable(String))",
  error_category: "LowCardinality(Nullable(String))",
  error_message: "Nullable(String)",
  is_retry: "UInt8",
  input_keys: "String",
  input_types: "String",
  intent_signals: "String",
  tokens_in: "Nullable(UInt32)",
  tokens_out: "Nullable(UInt32)",
  conversion_value: "Nullable(Float64)",
  conversion_currency: "LowCardinality(Nullable(String))",
  viewport_width: "Nullable(UInt16)",
  viewport_height: "Nullable(UInt16)",
  country_code: "LowCardinality(Nullable(String))",
  protocol_version: "Nullable(String)",
  client_name: "Nullable(String)",
  client_version: "Nullable(String)",
  connection_duration_ms: "Nullable(Float64)",
  scroll_depth_pct: "Nullable(Float64)",
  click_count: "Nullable(UInt32)",
  visible_duration_ms: "Nullable(Float64)",
  field_name: "Nullable(String)",
  nav_from: "Nullable(String)",
  nav_to: "Nullable(String)",
  device_touch: "Nullable(UInt8)",
  device_pixel_ratio: "Nullable(Float32)",
  connection_type: "LowCardinality(Nullable(String))",
  load_time_ms: "Nullable(Float64)",
  step_sequence: "Nullable(UInt32)",
  metadata: "String",
  sdk_version: "Nullable(String)",
  input_values: "String",
  output_content: "String",
  locale: "LowCardinality(Nullable(String))",
  end_user_agent: "Nullable(String)",
  subject_id: "Nullable(String)",
  intent_context: "LowCardinality(Nullable(String))",
  region: "LowCardinality(Nullable(String))",
  session_source: "LowCardinality(Nullable(String))",
};

/**
 * ClickHouse String columns require pre-serialized JSON — passing JS objects
 * via JSONEachRow silently drops the row. Stringify any object-valued fields
 * that map to String columns in the events table.
 */
const JSON_FIELDS = new Set([
  "metadata",
  "user_traits",
  "input_keys",
  "input_types",
  "input_values",
  "output_content",
  "intent_signals",
  "input_schema",
]);

/**
 * Convert an ISO 8601 timestamp (e.g. `2026-02-19T13:48:25.105Z`) to
 * the format ClickHouse DateTime64 expects in JSONEachRow:
 * `2026-02-19 13:48:25.105` (space separator, no trailing `Z`).
 */
export function toClickHouseDateTime(iso: string): string {
  return iso.replace("T", " ").replace("Z", "");
}

/** ES2024 string methods (Node 20+), not in the ES2022 lib this package builds against. */
type WellFormedString = string & { isWellFormed(): boolean; toWellFormed(): string };

/**
 * - Object-valued JSON fields are serialised (`JSON_FIELDS`).
 * - A string with a lone UTF-16 surrogate gets U+FFFD in its place, as
 *   TextEncoder does. JSON allows one ("\ud800"); UTF-8 cannot encode it,
 *   and ClickHouse refuses the row (CANNOT_PARSE_ESCAPE_SEQUENCE), which
 *   the batch writer would then drop. Inside a JSON field it is harmless:
 *   JSON.stringify escapes it as text, stored as is.
 */
function toColumnValues(event: Record<string, unknown>): Record<string, unknown> {
  const result = { ...event };
  for (const [field, value] of Object.entries(result)) {
    if (typeof value === "string") {
      if (!(value as WellFormedString).isWellFormed()) {
        result[field] = (value as WellFormedString).toWellFormed();
      }
    } else if (JSON_FIELDS.has(field) && value !== null && typeof value === "object") {
      result[field] = JSON.stringify(value);
    }
  }
  return result;
}

/**
 * Enrich validated events with the auth context. Also serializes
 * object-valued fields to JSON strings for ClickHouse, makes strings
 * well-formed UTF-16 (`toColumnValues`) and converts DateTime fields to
 * ClickHouse-compatible format. `ingested_at` is left to the column DEFAULT
 * (see `EnrichedEvent`).
 */
export function enrichEvents(events: BaseEvent[], authContext: AuthContext): EnrichedEvent[] {
  return events.map(
    (event) =>
      toColumnValues({
        ...event,
        timestamp: toClickHouseDateTime(event.timestamp),
        workspace_id: authContext.workspaceId,
        project_id: authContext.projectId,
      }) as EnrichedEvent,
  );
}
