import { randomUUID } from "node:crypto";
import { BaseEvent, IngestEvent } from "@yavio/shared/events";
import { describe, expect, it } from "vitest";
import { EVENTS_COLUMNS, enrichEvents } from "../lib/event-enricher.js";
import type { AuthContext } from "../types.js";

describe("EVENTS_COLUMNS", () => {
  it("lists every field an event can carry into events, and no other", () => {
    // tool_discovery's own fields go to tool_registry (tool-registry.ts).
    const fields = new Set<string>(["workspace_id", "project_id"]);
    for (const option of IngestEvent.options) {
      const discovery = option.shape.event_type.value === "tool_discovery";
      for (const field of Object.keys(option.shape)) {
        if (!discovery || field in BaseEvent.shape) fields.add(field);
      }
    }
    expect(Object.keys(EVENTS_COLUMNS).sort()).toEqual([...fields].sort());
  });
});

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
  it("adds workspace_id and project_id, and leaves ingested_at to the column DEFAULT", () => {
    const events = [makeEvent()];
    const enriched = enrichEvents(events, authContext);
    expect(enriched).toHaveLength(1);
    expect(enriched[0].workspace_id).toBe("workspace-1");
    expect(enriched[0].project_id).toBe("project-1");
    // Stamped by ClickHouse when the row is stored (`DEFAULT now64(3)`),
    // not by ingest on receipt: the batch writer inserts up to seconds
    // later, and the live feed's 10 s overlap on `ingested_at` must cover
    // the insert, not the write delay (#148 review round 5).
    expect(enriched[0]).not.toHaveProperty("ingested_at");
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
    expect(enriched.map((e) => e.project_id)).toEqual(["project-1", "project-1"]);
    expect(enriched.map((e) => e.event_id)).toEqual(events.map((e) => e.event_id));
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

  it("puts U+FFFD in place of a lone surrogate, which ClickHouse refuses in a String column", () => {
    const [event] = enrichEvents(
      [
        makeEvent({
          event_name: "a\ud800b",
          error_message: "\udc00 at the start, a pair 😀 kept",
          user_id: "\ud83d",
          metadata: { note: "x\ud800" },
        }),
      ],
      authContext,
    );
    expect(event.event_name).toBe("a�b");
    expect(event.error_message).toBe("� at the start, a pair 😀 kept");
    expect(event.user_id).toBe("�");
    // Inside a JSON field JSON.stringify escapes it as text, which ClickHouse stores.
    expect(event.metadata).toBe('{"note":"x\\ud800"}');
  });

  it("leaves well-formed strings as they are", () => {
    const original = makeEvent({ event_name: "ünïcödé 😀 ✓" });
    const [event] = enrichEvents([original], authContext);
    expect(event.event_name).toBe("ünïcödé 😀 ✓");
    expect(event.trace_id).toBe(original.trace_id);
  });
});
