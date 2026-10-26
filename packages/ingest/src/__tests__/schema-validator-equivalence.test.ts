import { IngestBatch, IngestEvent, MAX_BATCH_EVENTS } from "@yavio/shared/events";
import type { BaseEvent } from "@yavio/shared/events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ISSUES_PER_EVENT,
  MAX_REPORTED_ERRORS,
  validateBatch,
} from "../lib/schema-validator.js";

// validateBatch parses each event once instead of the batch schema first and
// every event again when it fails. Its accept/reject decisions must stay
// those of the previous algorithm, kept here as the reference: the same
// valid events, the same rejected indices, the same issues (the new one lists
// the first MAX_REPORTED_ERRORS errors and MAX_ISSUES_PER_EVENT issues each).

interface Reference {
  valid: BaseEvent[];
  errors: Array<{ index: number; issues: string[] }>;
}

function flatten(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues.map(
    (i) => `${i.path.length > 0 ? `${i.path.map(String).join(".")}: ` : ""}${i.message}`,
  );
}

/** The algorithm before the change (within the cap), without any bound. */
function reference(body: unknown): Reference {
  const result = IngestBatch.safeParse(body);
  if (result.success) return { valid: result.data.events, errors: [] };
  const obj = body as Record<string, unknown> | null;
  if (!obj || !Array.isArray(obj.events) || obj.events.length === 0) {
    return { valid: [], errors: [{ index: -1, issues: flatten(result.error) }] };
  }
  const valid: BaseEvent[] = [];
  const errors: Reference["errors"] = [];
  obj.events.forEach((event, index) => {
    const parsed = IngestEvent.safeParse(event);
    if (parsed.success) valid.push(parsed.data);
    else errors.push({ index, issues: flatten(parsed.error) });
  });
  return { valid, errors };
}

/** A small deterministic PRNG, so the corpus is the same on every run. */
function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

const EVENT_TYPES = [
  "tool_call",
  "connection",
  "resource_access",
  "tool_discovery",
  "step",
  "track",
  "conversion",
  "identify",
  "widget_render",
  "widget_click",
  "widget_scroll",
  "widget_form_field",
  "widget_navigation",
  "widget_rage_click",
];

function corpus(): unknown[] {
  const random = prng(20261026);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
  const uuid = (i: number) => `550e8400-e29b-41d4-a716-${String(i).padStart(12, "0")}`;

  const goodEvent = (i: number): Record<string, unknown> => {
    const type = pick(EVENT_TYPES);
    const event: Record<string, unknown> = {
      event_id: uuid(i),
      event_type: type,
      trace_id: `tr_${i}`,
      session_id: `ses_${i % 7}`,
      timestamp: new Date(Date.UTC(2026, 9, 26, 10, 0, i % 60)).toISOString(),
      source: type.startsWith("widget") ? "widget" : "server",
    };
    if (type === "tool_call") Object.assign(event, { latency_ms: i, status: "success" });
    if (type === "tool_discovery") Object.assign(event, { tool_name: `tool_${i}` });
    if (type === "conversion")
      Object.assign(event, { conversion_value: 9.5, conversion_currency: "EUR" });
    if (random() < 0.3) event.metadata = { k: i, nested: { a: [1, 2] } };
    if (random() < 0.2) event.extra_field = "ignored";
    return event;
  };

  const breakEvent = (event: Record<string, unknown>): unknown => {
    const broken = { ...event };
    switch (Math.floor(random() * 12)) {
      case 0:
        broken.event_type = undefined;
        break;
      case 1:
        broken.event_type = "not_a_type";
        break;
      case 2:
        broken.event_id = "not-a-uuid";
        break;
      case 3:
        broken.timestamp = "yesterday";
        break;
      case 4:
        broken.source = "browser";
        break;
      case 5:
        broken.trace_id = 42;
        break;
      case 6:
        broken.metadata = "a string";
        break;
      case 7:
        Object.assign(broken, {
          event_type: "tool_call",
          latency_ms: "slow",
          status: "maybe",
          error_category: "other",
          is_retry: 3,
          tokens_in: 1.5,
          tokens_out: "many",
          country_code: "DEU",
          intent_context: "always",
          locale: "x".repeat(40),
          end_user_agent: 5,
          subject_id: [],
        });
        break;
      case 8:
        return null;
      case 9:
        return "event";
      case 10:
        return [event];
      default:
        Object.assign(broken, { event_type: "conversion", conversion_currency: "EURO" });
    }
    return broken;
  };

  const bodies: unknown[] = [
    null,
    undefined,
    "a string",
    42,
    [],
    [goodEvent(0)],
    {},
    { events: null },
    { events: "x" },
    { events: {} },
    { events: [] },
    { events: [goodEvent(1)], sdk_version: "0.5.5", sent_at: "now" },
  ];
  for (let b = 0; b < 300; b++) {
    const size = 1 + Math.floor(random() * (b % 10 === 0 ? MAX_BATCH_EVENTS : 40));
    const share = pick([0, 0.05, 0.3, 0.7, 1]);
    const events = Array.from({ length: size }, (_, i) => {
      const event = goodEvent(b * 1_000 + i);
      return random() < share ? breakEvent(event) : event;
    });
    bodies.push({ events });
  }
  return bodies;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateBatch — same decisions as the previous algorithm", () => {
  it("accepts and rejects exactly what the reference does over the corpus", () => {
    let bodies = 0;
    let accepted = 0;
    let rejected = 0;
    for (const body of corpus()) {
      const expected = reference(body);
      const actual = validateBatch(body);
      bodies++;

      expect(actual.valid).toEqual(expected.valid);
      expect(actual.rejected).toBe(expected.errors.length);
      expect(actual.errors).toEqual(
        expected.errors.slice(0, MAX_REPORTED_ERRORS).map((e) => ({
          index: e.index,
          issues: e.issues.slice(0, MAX_ISSUES_PER_EVENT),
        })),
      );
      accepted += actual.valid.length;
      rejected += actual.rejected;
    }
    // The corpus covers both outcomes in quantity.
    expect(bodies).toBe(312);
    expect(accepted).toBe(12_753);
    expect(rejected).toBe(7_795);
  }, 30_000); // about 20,000 events, parsed by both algorithms

  it("parses each event once, and does not run the batch schema, for a batch within the cap", () => {
    const batchParse = vi.spyOn(IngestBatch, "safeParse");
    const eventParse = vi.spyOn(IngestEvent, "safeParse");
    const events = Array.from({ length: 50 }, (_, i) => ({
      event_id: `550e8400-e29b-41d4-a716-${String(i).padStart(12, "0")}`,
      event_type: i % 2 === 0 ? "track" : "nope",
      trace_id: "tr_1",
      session_id: "ses_1",
      timestamp: "2026-10-26T10:00:00.000Z",
      source: "server",
    }));

    const result = validateBatch({ events });

    expect(batchParse).not.toHaveBeenCalled();
    expect(eventParse).toHaveBeenCalledTimes(50);
    expect(result.valid).toHaveLength(25);
    expect(result.rejected).toBe(25);
  });

  it("lists at most 10 issues per event", () => {
    const result = validateBatch({
      events: [
        {
          event_id: "x",
          event_type: "tool_call",
          trace_id: 1,
          session_id: 2,
          timestamp: "t",
          source: "s",
          latency_ms: "a",
          status: "b",
          error_category: "c",
          is_retry: "d",
          tokens_in: "e",
          tokens_out: "f",
          country_code: 3,
          locale: 4,
        },
      ],
    });
    expect(result.rejected).toBe(1);
    expect(result.errors[0].issues).toHaveLength(MAX_ISSUES_PER_EVENT);
  });
});
