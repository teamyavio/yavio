import { randomUUID } from "node:crypto";
import type { BaseEvent } from "@yavio/shared/events";
import { describe, expect, it } from "vitest";
import { enforceFieldLimits, isBatchTooLarge } from "../lib/field-limits.js";

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

describe("isBatchTooLarge", () => {
  it("returns false for small batch", () => {
    expect(isBatchTooLarge('{"events":[]}')).toBe(false);
  });

  it("returns true for batch exceeding 500KB", () => {
    const large = "x".repeat(512_001);
    expect(isBatchTooLarge(large)).toBe(true);
  });

  it("accepts buffer input", () => {
    expect(isBatchTooLarge(Buffer.from("small"))).toBe(false);
  });
});

describe("enforceFieldLimits", () => {
  it("accepts normal events without warnings", () => {
    const result = enforceFieldLimits([makeEvent()]);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("rejects events exceeding 50KB total size", () => {
    const event = makeEvent({ metadata: { big: "x".repeat(60_000) } });
    const result = enforceFieldLimits([event]);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain("50KB");
  });

  it("rejects events with event_name exceeding 256 chars", () => {
    const event = makeEvent({ event_name: "a".repeat(257) });
    const result = enforceFieldLimits([event]);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain("event_name");
  });

  it("rejects events with trace_id exceeding 128 chars", () => {
    const event = makeEvent({ trace_id: "t".repeat(129) });
    const result = enforceFieldLimits([event]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain("trace_id");
  });

  it("rejects events with session_id exceeding 128 chars", () => {
    const event = makeEvent({ session_id: "s".repeat(129) });
    const result = enforceFieldLimits([event]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain("session_id");
  });

  it("truncates metadata exceeding 10KB", () => {
    const event = makeEvent({ metadata: { data: "x".repeat(11_000) } });
    const result = enforceFieldLimits([event]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].metadata).toEqual({ _truncated: true });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].field).toBe("metadata");
  });

  it("truncates user_traits exceeding 5KB", () => {
    const event = makeEvent({ user_traits: { data: "x".repeat(6_000) } });
    const result = enforceFieldLimits([event]);
    expect(result.accepted).toHaveLength(1);
    expect((result.accepted[0] as Record<string, unknown>).user_traits).toEqual({
      _truncated: true,
    });
    expect(result.warnings[0].field).toBe("user_traits");
  });

  it("truncates input_keys exceeding 5KB", () => {
    const event = makeEvent({ input_keys: { data: "x".repeat(6_000) } });
    const result = enforceFieldLimits([event]);
    expect(result.accepted).toHaveLength(1);
    expect((result.accepted[0] as Record<string, unknown>).input_keys).toEqual({
      _truncated: true,
    });
    expect(result.warnings[0].field).toBe("input_keys");
  });

  it("truncates input_types exceeding 5KB", () => {
    const event = makeEvent({ input_types: { data: "x".repeat(6_000) } });
    const result = enforceFieldLimits([event]);
    expect(result.accepted).toHaveLength(1);
    expect((result.accepted[0] as Record<string, unknown>).input_types).toEqual({
      _truncated: true,
    });
    expect(result.warnings[0].field).toBe("input_types");
  });

  it("truncates input_values exceeding 10KB", () => {
    const event = makeEvent({ input_values: { data: "x".repeat(11_000) } });
    const result = enforceFieldLimits([event]);
    expect(result.accepted).toHaveLength(1);
    expect((result.accepted[0] as Record<string, unknown>).input_values).toEqual({
      _truncated: true,
    });
    expect(result.warnings[0].field).toBe("input_values");
  });

  it("truncates output_content exceeding 10KB", () => {
    const event = makeEvent({ output_content: { content: [{ text: "x".repeat(11_000) }] } });
    const result = enforceFieldLimits([event]);
    expect(result.accepted).toHaveLength(1);
    expect((result.accepted[0] as Record<string, unknown>).output_content).toEqual({
      _truncated: true,
    });
    expect(result.warnings[0].field).toBe("output_content");
  });

  it("truncates intent_signals exceeding 2KB", () => {
    const event = makeEvent({ intent_signals: { data: "x".repeat(3_000) } });
    const result = enforceFieldLimits([event]);
    expect(result.accepted).toHaveLength(1);
    expect((result.accepted[0] as Record<string, unknown>).intent_signals).toEqual({
      _truncated: true,
    });
    expect(result.warnings[0].field).toBe("intent_signals");
  });

  it("truncates error_message exceeding 2KB", () => {
    const event = makeEvent({ error_message: "e".repeat(3_000) });
    const result = enforceFieldLimits([event]);
    expect(result.accepted).toHaveLength(1);
    const msg = (result.accepted[0] as Record<string, unknown>).error_message as string;
    expect(msg).toContain("[truncated]");
    expect(msg.length).toBeLessThan(3_000);
  });

  it("handles mixed valid and invalid events", () => {
    const events = [
      makeEvent(),
      makeEvent({ event_name: "x".repeat(300) }), // too long
      makeEvent(),
    ];
    const result = enforceFieldLimits(events);
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].index).toBe(1);
  });

  it("does not mutate original events", () => {
    const original = makeEvent({ metadata: { data: "x".repeat(11_000) } });
    const originalMeta = original.metadata;
    enforceFieldLimits([original]);
    expect(original.metadata).toBe(originalMeta);
  });
});
