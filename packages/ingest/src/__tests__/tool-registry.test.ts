import { describe, expect, it } from "vitest";
import type { EnrichedEvent } from "../lib/event-enricher.js";
import { mapToolRegistryRow } from "../lib/tool-registry.js";

function discovery(extra: Record<string, unknown> = {}): EnrichedEvent {
  return {
    event_id: "4b6f3a52-1c3e-4c5e-9a3d-8e2f1b7c6d5a",
    event_type: "tool_discovery",
    trace_id: "t",
    session_id: "s",
    // As the normalizer and enricher leave it: milliseconds, ClickHouse format.
    timestamp: "2026-10-26 12:00:00.123",
    source: "server",
    workspace_id: "w",
    project_id: "p-1",
    tool_name: "search",
    ...extra,
  };
}

describe("mapToolRegistryRow", () => {
  it("maps a tool_discovery event to a tool_registry row, registered_at from its timestamp", () => {
    const row = mapToolRegistryRow(discovery({ description: "Find things" }));
    expect(row).toMatchObject({
      project_id: "p-1",
      tool_name: "search",
      description: "Find things",
      input_schema: "{}",
      registered_at: "2026-10-26 12:00:00.123",
    });
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  it("serialises an input schema, or takes one the enricher already serialised", () => {
    expect(mapToolRegistryRow(discovery({ input_schema: { type: "object" } })).input_schema).toBe(
      '{"type":"object"}',
    );
    expect(mapToolRegistryRow(discovery({ input_schema: '{"type":"object"}' })).input_schema).toBe(
      '{"type":"object"}',
    );
    expect(mapToolRegistryRow(discovery({ tool_name: undefined })).tool_name).toBe("");
    expect(mapToolRegistryRow(discovery()).description).toBeNull();
  });
});
