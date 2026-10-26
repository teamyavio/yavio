import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateBatch } from "../lib/schema-validator.js";

// The numeric bounds of @yavio/shared/events (numeric-bounds.test.ts there)
// as ingest applies them: an event with a value its column cannot store is
// rejected on its own, with the per-event error shape the route returns in
// a 207 or 400 body, and the other events of the batch are accepted.

function event(eventType: string, extra: Record<string, unknown>) {
  return {
    event_id: randomUUID(),
    event_type: eventType,
    trace_id: "trace-1",
    session_id: "session-1",
    timestamp: new Date().toISOString(),
    source: "server",
    ...extra,
  };
}

describe("numeric bounds in validateBatch", () => {
  it.each([
    ["UInt32 below 0", "tool_call", { tokens_in: -1 }, "tokens_in"],
    ["UInt32 above 2^32 − 1", "step", { step_sequence: 2 ** 32 }, "step_sequence"],
    ["UInt32 in exponent notation (1e21)", "widget_click", { click_count: 1e21 }, "click_count"],
    ["UInt16 above 65,535", "widget_render", { viewport_width: 65_536 }, "viewport_width"],
    [
      "Float32 beyond its range",
      "widget_render",
      { device_pixel_ratio: 1e39 },
      "device_pixel_ratio",
    ],
    [
      "Float64 Infinity (JSON 1e999)",
      "tool_call",
      { latency_ms: JSON.parse("1e999") },
      "latency_ms",
    ],
  ])("rejects %s per event", (_, eventType, extra, field) => {
    const valid = event(eventType, {});
    const result = validateBatch({ events: [valid, event(eventType, extra)] });
    expect(result.valid.map((e) => e.event_id)).toEqual([valid.event_id]);
    expect(result.errors).toEqual([{ index: 1, issues: [expect.stringMatching(`^${field}: `)] }]);
  });

  it("accepts the largest value each column stores, and a fraction or a negative in a Float64 column", () => {
    const result = validateBatch({
      events: [
        event("tool_call", { tokens_in: 2 ** 32 - 1, tokens_out: 0, latency_ms: -0.5 }),
        event("widget_render", {
          viewport_width: 65_535,
          viewport_height: 0,
          device_pixel_ratio: 3.4028234663852886e38,
        }),
        event("conversion", { conversion_value: Number.MAX_VALUE }),
        event("widget_visibility", { visible_duration_ms: 1e21 }),
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toHaveLength(4);
  });
});
