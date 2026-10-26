import { describe, expect, it } from "vitest";
import { IngestEvent } from "../events.js";

// String fields with no other bound (the id fields and error_message are
// limited by ingest's field limits) carry a schema maximum.

function base(overrides: Record<string, unknown>) {
  return {
    event_id: "550e8400-e29b-41d4-a716-446655440000",
    trace_id: "tr_1",
    session_id: "ses_1",
    timestamp: "2026-10-26T10:00:00.000Z",
    source: "server",
    ...overrides,
  };
}

const cases: Array<[string, Record<string, unknown>, string, number]> = [
  ["platform", { event_type: "track" }, "platform", 64],
  ["sdk_version", { event_type: "track" }, "sdk_version", 64],
  ["protocol_version", { event_type: "connection" }, "protocol_version", 64],
  ["client_name", { event_type: "connection" }, "client_name", 256],
  ["client_version", { event_type: "connection" }, "client_version", 128],
  ["connection_type", { event_type: "widget_render", source: "widget" }, "connection_type", 32],
  ["field_name", { event_type: "widget_form_field", source: "widget" }, "field_name", 256],
  ["nav_from", { event_type: "widget_navigation", source: "widget" }, "nav_from", 2048],
  ["nav_to", { event_type: "widget_navigation", source: "widget" }, "nav_to", 2048],
];

describe("IngestEvent — bounded string fields", () => {
  it.each(cases)("%s accepts its maximum and rejects one more", (_name, shape, field, max) => {
    expect(IngestEvent.safeParse(base({ ...shape, [field]: "x".repeat(max) })).success).toBe(true);
    const over = IngestEvent.safeParse(base({ ...shape, [field]: "x".repeat(max + 1) }));
    expect(over.success).toBe(false);
    if (!over.success) expect(over.error.issues[0].path).toEqual([field]);
  });

  it("accepts what the SDKs send", () => {
    expect(
      IngestEvent.safeParse(
        base({
          event_type: "connection",
          platform: "chatgpt",
          sdk_version: "0.5.5",
          protocol_version: "2025-06-18",
          client_name: "openai-mcp",
          client_version: "1.0.0",
        }),
      ).success,
    ).toBe(true);
    expect(
      IngestEvent.safeParse(
        base({ event_type: "widget_render", source: "widget", connection_type: "4g" }),
      ).success,
    ).toBe(true);
  });
});
