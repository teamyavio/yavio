import { type EnrichedEvent, toClickHouseDateTime } from "./event-enricher.js";

/**
 * A `tool_discovery` event as a `tool_registry` row (migration 0006).
 *
 * The two DateTime64(3) columns get milliseconds: `registered_at` is the
 * event's timestamp, which the normalizer writes with milliseconds and the
 * enricher converts (`toClickHouseDateTime`); `updated_at` is stamped here.
 */
export function mapToolRegistryRow(event: EnrichedEvent): Record<string, unknown> {
  const inputSchema = event.input_schema;
  let inputSchemaStr = "{}";
  if (inputSchema !== undefined && inputSchema !== null) {
    inputSchemaStr =
      typeof inputSchema === "object" ? JSON.stringify(inputSchema) : String(inputSchema);
  }

  return {
    project_id: event.project_id,
    tool_name: String(event.tool_name ?? ""),
    description: event.description ?? null,
    input_schema: inputSchemaStr,
    registered_at: String(event.timestamp),
    // The registry's version column (ReplacingMergeTree keeps the latest):
    // stamped here, not on the event — `ingested_at` is ClickHouse's to set
    // since #148 review round 5, and tool_registry.updated_at has no DEFAULT.
    updated_at: toClickHouseDateTime(new Date().toISOString()),
  };
}
