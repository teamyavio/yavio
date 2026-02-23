import type { BaseEvent } from "@yavio/shared/events";
import type { AuthContext } from "../types.js";

export interface EnrichedEvent extends Record<string, unknown> {
  workspace_id: string;
  project_id: string;
  ingested_at: string;
}

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
function toClickHouseDateTime(iso: string): string {
  return iso.replace("T", " ").replace("Z", "");
}

function stringifyJsonFields(event: Record<string, unknown>): Record<string, unknown> {
  const result = { ...event };
  for (const field of JSON_FIELDS) {
    const value = result[field];
    if (value !== undefined && value !== null && typeof value === "object") {
      result[field] = JSON.stringify(value);
    }
  }
  return result;
}

/**
 * Enrich validated events with auth context and ingestion timestamp.
 * Also serializes object-valued fields to JSON strings for ClickHouse
 * and converts DateTime fields to ClickHouse-compatible format.
 */
export function enrichEvents(events: BaseEvent[], authContext: AuthContext): EnrichedEvent[] {
  const ingestedAt = toClickHouseDateTime(new Date().toISOString());

  return events.map(
    (event) =>
      stringifyJsonFields({
        ...event,
        timestamp: toClickHouseDateTime(event.timestamp),
        workspace_id: authContext.workspaceId,
        project_id: authContext.projectId,
        ingested_at: ingestedAt,
      }) as EnrichedEvent,
  );
}
