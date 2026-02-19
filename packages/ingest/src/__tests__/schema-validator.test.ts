import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateBatch } from "../lib/schema-validator.js";

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: randomUUID(),
    event_type: "track",
    trace_id: "trace-1",
    session_id: "session-1",
    timestamp: new Date().toISOString(),
    source: "server",
    ...overrides,
  };
}

describe("validateBatch", () => {
  it("accepts a valid batch", () => {
    const result = validateBatch({ events: [makeEvent()] });
    expect(result.valid).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts multiple valid events", () => {
    const result = validateBatch({
      events: [makeEvent(), makeEvent({ event_type: "step" })],
    });
    expect(result.valid).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects when body is not an object", () => {
    const result = validateBatch("not an object");
    expect(result.valid).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].index).toBe(-1);
  });

  it("rejects when events is not an array", () => {
    const result = validateBatch({ events: "not-array" });
    expect(result.valid).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
  });

  it("rejects empty events array", () => {
    const result = validateBatch({ events: [] });
    expect(result.valid).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("partitions valid and invalid events", () => {
    const result = validateBatch({
      events: [makeEvent(), { bad: "event" }, makeEvent({ event_type: "conversion" })],
    });
    expect(result.valid).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].index).toBe(1);
  });

  it("reports specific validation issues", () => {
    const result = validateBatch({
      events: [makeEvent({ event_type: "not-a-valid-type" })],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].issues.length).toBeGreaterThan(0);
  });

  it("rejects events with missing required fields", () => {
    const result = validateBatch({
      events: [{ event_id: randomUUID() }],
    });
    expect(result.valid).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
  });

  it("accepts events with optional fields", () => {
    const result = validateBatch({
      events: [makeEvent({ event_name: "my-event", metadata: { key: "value" } })],
    });
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].event_name).toBe("my-event");
  });

  it("preserves tool_call-specific fields through validation", () => {
    const result = validateBatch({
      events: [
        makeEvent({
          event_type: "tool_call",
          latency_ms: 42.5,
          status: "success",
          input_keys: { query: true },
          input_types: { query: "string" },
          intent_signals: { intent: "search" },
          tokens_in: 100,
          tokens_out: 200,
          country_code: "US",
          error_message: "something failed",
        }),
      ],
    });
    expect(result.valid).toHaveLength(1);
    const event = result.valid[0] as Record<string, unknown>;
    expect(event.latency_ms).toBe(42.5);
    expect(event.status).toBe("success");
    expect(event.input_keys).toEqual({ query: true });
    expect(event.input_types).toEqual({ query: "string" });
    expect(event.intent_signals).toEqual({ intent: "search" });
    expect(event.tokens_in).toBe(100);
    expect(event.tokens_out).toBe(200);
    expect(event.country_code).toBe("US");
    expect(event.error_message).toBe("something failed");
  });

  it("preserves identify-specific fields through validation", () => {
    const result = validateBatch({
      events: [
        makeEvent({
          event_type: "identify",
          user_id: "user-123",
          user_traits: { plan: "pro", age: 30 },
        }),
      ],
    });
    expect(result.valid).toHaveLength(1);
    const event = result.valid[0] as Record<string, unknown>;
    expect(event.user_id).toBe("user-123");
    expect(event.user_traits).toEqual({ plan: "pro", age: 30 });
  });

  it("preserves conversion-specific fields through validation", () => {
    const result = validateBatch({
      events: [
        makeEvent({
          event_type: "conversion",
          conversion_value: 99.99,
          conversion_currency: "USD",
        }),
      ],
    });
    expect(result.valid).toHaveLength(1);
    const event = result.valid[0] as Record<string, unknown>;
    expect(event.conversion_value).toBe(99.99);
    expect(event.conversion_currency).toBe("USD");
  });

  it("preserves widget event-specific fields through validation", () => {
    const result = validateBatch({
      events: [
        makeEvent({
          event_type: "widget_render",
          source: "widget",
          viewport_width: 1920,
          viewport_height: 1080,
          device_pixel_ratio: 2.0,
          device_touch: 1,
          connection_type: "wifi",
        }),
      ],
    });
    expect(result.valid).toHaveLength(1);
    const event = result.valid[0] as Record<string, unknown>;
    expect(event.viewport_width).toBe(1920);
    expect(event.viewport_height).toBe(1080);
    expect(event.device_pixel_ratio).toBe(2.0);
    expect(event.device_touch).toBe(1);
    expect(event.connection_type).toBe("wifi");
  });

  it("preserves SDK-enrichment fields (user_id, platform, sdk_version)", () => {
    const result = validateBatch({
      events: [
        makeEvent({
          user_id: "user-456",
          platform: "node",
          sdk_version: "1.0.0",
        }),
      ],
    });
    expect(result.valid).toHaveLength(1);
    const event = result.valid[0] as Record<string, unknown>;
    expect(event.user_id).toBe("user-456");
    expect(event.platform).toBe("node");
    expect(event.sdk_version).toBe("1.0.0");
  });

  it("rejects tool_call with invalid typed fields", () => {
    const result = validateBatch({
      events: [
        makeEvent({
          event_type: "tool_call",
          latency_ms: "not-a-number",
        }),
      ],
    });
    expect(result.valid).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].issues.some((i) => i.includes("latency_ms"))).toBe(true);
  });

  it("preserves fields in partial-success batch (individual event fallback)", () => {
    const result = validateBatch({
      events: [
        makeEvent({
          event_type: "tool_call",
          latency_ms: 50,
          status: "error",
          error_message: "timeout",
        }),
        { bad: "event" },
      ],
    });
    expect(result.valid).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    const event = result.valid[0] as Record<string, unknown>;
    expect(event.latency_ms).toBe(50);
    expect(event.status).toBe("error");
    expect(event.error_message).toBe("timeout");
  });
});
