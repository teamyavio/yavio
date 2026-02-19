import { randomUUID } from "node:crypto";
import type { BaseEvent } from "@yavio/shared/events";
import { describe, expect, it } from "vitest";
import { enrichEvents } from "../lib/event-enricher.js";
import type { AuthContext } from "../types.js";

function makeEvent(overrides: Record<string, unknown> = {}): BaseEvent {
  return {
    event_id: randomUUID(),
    event_type: "track",
    trace_id: "trace-1",
    session_id: "session-1",
    timestamp: new Date().toISOString(),
    source: "server",
    ...overrides,
  } as BaseEvent;
}

const authContext: AuthContext = {
  projectId: "project-1",
  workspaceId: "workspace-1",
  source: "api_key",
};

describe("enrichEvents", () => {
  it("adds workspace_id, project_id, and ingested_at", () => {
    const events = [makeEvent()];
    const enriched = enrichEvents(events, authContext);
    expect(enriched).toHaveLength(1);
    expect(enriched[0].workspace_id).toBe("workspace-1");
    expect(enriched[0].project_id).toBe("project-1");
    expect(enriched[0].ingested_at).toBeDefined();
  });

  it("preserves original event fields", () => {
    const events = [makeEvent({ event_name: "my-event" })];
    const enriched = enrichEvents(events, authContext);
    expect(enriched[0].event_name).toBe("my-event");
    expect(enriched[0].event_type).toBe("track");
  });

  it("enriches multiple events", () => {
    const events = [makeEvent(), makeEvent()];
    const enriched = enrichEvents(events, authContext);
    expect(enriched).toHaveLength(2);
    expect(enriched[0].ingested_at).toBe(enriched[1].ingested_at);
  });

  it("stringifies metadata objects for ClickHouse", () => {
    const events = [makeEvent({ metadata: { key: "value" } })];
    const enriched = enrichEvents(events, authContext);
    expect(enriched[0].metadata).toBe('{"key":"value"}');
  });

  it("stringifies user_traits, input_keys, input_types, intent_signals", () => {
    const events = [
      makeEvent({
        user_traits: { plan: "pro" },
        input_keys: { query: true },
        input_types: { query: "string" },
        intent_signals: { intent: "search" },
      }),
    ];
    const enriched = enrichEvents(events, authContext);
    expect(enriched[0].user_traits).toBe('{"plan":"pro"}');
    expect(enriched[0].input_keys).toBe('{"query":true}');
    expect(enriched[0].input_types).toBe('{"query":"string"}');
    expect(enriched[0].intent_signals).toBe('{"intent":"search"}');
  });

  it("leaves undefined and string JSON fields untouched", () => {
    const events = [makeEvent({ metadata: undefined })];
    const enriched = enrichEvents(events, authContext);
    expect(enriched[0].metadata).toBeUndefined();
  });
});
