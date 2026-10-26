import { describe, expect, it } from "vitest";
import { IngestEvent } from "../events.js";

// Every numeric event field is bounded by its ClickHouse column
// (packages/db/migrations/clickhouse/0002_events_table.sql): an event with
// a value the column cannot store is rejected on its own at validation,
// instead of reaching ClickHouse, which refuses the row (UInt*: a negative,
// a fraction, or a number JSON.stringify writes in exponent notation, 1e21
// and up) or stores another value (UInt*: an integer beyond the type wraps
// around; Float32: beyond its range becomes inf; Float*: ±Infinity, what
// JSON.parse makes of 1e999, is serialised as null).

const UINT16_MAX = 2 ** 16 - 1;
const UINT32_MAX = 2 ** 32 - 1;
const FLOAT32_MAX = 3.4028234663852886e38;

type Kind = "UInt8 0/1" | "UInt16" | "UInt32" | "Float32" | "Float64" | "Float64 0..100";

/** Field → column, per event type. */
const FIELDS: Array<[eventType: string, field: string, kind: Kind]> = [
  ["tool_call", "latency_ms", "Float64"],
  ["tool_call", "is_retry", "UInt8 0/1"],
  ["tool_call", "tokens_in", "UInt32"],
  ["tool_call", "tokens_out", "UInt32"],
  ["connection", "connection_duration_ms", "Float64"],
  ["sampling_call", "latency_ms", "Float64"],
  ["sampling_call", "tokens_in", "UInt32"],
  ["sampling_call", "tokens_out", "UInt32"],
  ["elicitation", "latency_ms", "Float64"],
  ["step", "step_sequence", "UInt32"],
  ["conversion", "conversion_value", "Float64"],
  ["widget_render", "viewport_width", "UInt16"],
  ["widget_render", "viewport_height", "UInt16"],
  ["widget_render", "device_pixel_ratio", "Float32"],
  ["widget_render", "device_touch", "UInt8 0/1"],
  ["widget_visibility", "visible_duration_ms", "Float64"],
  ["widget_click", "click_count", "UInt32"],
  ["widget_scroll", "scroll_depth_pct", "Float64 0..100"],
  ["widget_performance", "load_time_ms", "Float64"],
];

const ACCEPTED: Record<Kind, number[]> = {
  "UInt8 0/1": [0, 1],
  UInt16: [0, 1, UINT16_MAX],
  UInt32: [0, 1, UINT16_MAX + 1, UINT32_MAX],
  // A fraction, a negative and exponent notation are stored as sent.
  Float32: [0, 1.5, -2, 1e-7, FLOAT32_MAX, -FLOAT32_MAX],
  Float64: [0, 1.5, -2, 1e21, -1e300, Number.MAX_VALUE, Number.MIN_VALUE],
  "Float64 0..100": [0, 37.5, 100],
};

const REJECTED: Record<Kind, number[]> = {
  "UInt8 0/1": [-1, 2, 0.5, Number.POSITIVE_INFINITY],
  UInt16: [-1, UINT16_MAX + 1, 1e21, 1.5, Number.POSITIVE_INFINITY],
  UInt32: [-1, UINT32_MAX + 1, 2 ** 53, 1e21, 1.5, Number.POSITIVE_INFINITY],
  Float32: [FLOAT32_MAX * 1.001, -FLOAT32_MAX * 1.001, 1e300, Number.POSITIVE_INFINITY],
  Float64: [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN],
  "Float64 0..100": [-0.1, 100.1, Number.POSITIVE_INFINITY],
};

function event(eventType: string, extra: Record<string, unknown>) {
  return {
    event_id: "550e8400-e29b-41d4-a716-446655440000",
    event_type: eventType,
    trace_id: "tr_abc123",
    session_id: "ses_xyz789",
    timestamp: "2026-10-26T12:00:00.000Z",
    source: "server",
    ...extra,
  };
}

describe("numeric event fields are bounded by their column types", () => {
  it.each(FIELDS)("%s.%s (%s) accepts what the column stores", (eventType, field, kind) => {
    for (const value of ACCEPTED[kind]) {
      const parsed = IngestEvent.safeParse(event(eventType, { [field]: value }));
      expect(parsed.success, `${field}: ${value}`).toBe(true);
      expect((parsed.data as Record<string, unknown>)[field]).toBe(value);
    }
  });

  it.each(FIELDS)("%s.%s (%s) rejects what the column cannot store", (eventType, field, kind) => {
    for (const value of REJECTED[kind]) {
      const parsed = IngestEvent.safeParse(event(eventType, { [field]: value }));
      expect(parsed.success, `${field}: ${value}`).toBe(false);
      // Rejected for that field alone (one issue or several, all on it).
      expect([...new Set(parsed.error?.issues.map((i) => i.path.join(".")))]).toEqual([field]);
    }
  });

  it("JSON 1e999 parses to Infinity, which no numeric field takes", () => {
    const body = JSON.parse('{"latency_ms": 1e999, "conversion_value": -1e999}');
    expect(body.latency_ms).toBe(Number.POSITIVE_INFINITY);
    expect(IngestEvent.safeParse(event("tool_call", { latency_ms: body.latency_ms })).success).toBe(
      false,
    );
    expect(
      IngestEvent.safeParse(event("conversion", { conversion_value: body.conversion_value }))
        .success,
    ).toBe(false);
  });

  it("the table above lists every numeric field of every event type", () => {
    const listed = new Set(FIELDS.map(([type, field]) => `${type}.${field}`));
    const numeric: string[] = [];
    for (const option of IngestEvent.options) {
      const type = option.shape.event_type.value;
      for (const [field, schema] of Object.entries(option.shape)) {
        const takesNumber = (schema as { safeParse(v: unknown): { success: boolean } }).safeParse(
          0,
        );
        const takesText = (schema as { safeParse(v: unknown): { success: boolean } }).safeParse(
          "x",
        );
        // `region` takes anything (the normalizer keeps only a string).
        if (takesNumber.success && !takesText.success) numeric.push(`${type}.${field}`);
      }
    }
    expect(numeric.sort()).toEqual([...listed].sort());
  });
});
