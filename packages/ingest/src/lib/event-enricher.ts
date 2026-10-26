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
